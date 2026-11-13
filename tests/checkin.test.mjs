import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { billKey, isPositiveGrant, reconcileCheckin } from '../src/checkin.mjs'
import { claimDaily, claimHint, resetRateWait, setCaptchaSolver } from '../src/claim.mjs'
import { resetClientConfigs } from '../src/catalog.mjs'
import { APP_VERSION, keyDevice } from '../src/zcode.mjs'

const done = { outcome: 'done', credit: 0, message: '今日已签到' }

test('billKey 依次使用 bill_id、biz_id 和内容指纹', () => {
  assert.equal(billKey({ bill_id: 'bill-1', biz_id: 'biz-1' }), 'bill-1')
  assert.equal(billKey({ biz_id: 'biz-1' }), 'biz-1')
  assert.equal(
    billKey({ created_at: '2026-11-03T08:00:00+08:00', points: 10, event_name: '每日签到' }),
    '2026-11-03T08:00:00+08:00:10:每日签到'
  )
  assert.equal(billKey(null), ':0:')
})

test('isPositiveGrant 只接受归一化后的正积分', () => {
  assert.equal(isPositiveGrant({ points: 1 }), true)
  assert.equal(isPositiveGrant({ points: '10.9' }), true)
  assert.equal(isPositiveGrant({ points: 0 }), false)
  assert.equal(isPositiveGrant({ points: -1 }), false)
  assert.equal(isPositiveGrant({ points: '无效' }), false)
  assert.equal(isPositiveGrant(null), false)
})

test('before 中已有的历史账单不会再次计入', () => {
  const historical = { bill_id: 'old', points: 20, event_name: '历史签到' }
  const current = { bill_id: 'new', points: 10, event_name: '每日签到' }

  const result = reconcileCheckin({ before: [historical], after: [historical, current] })

  assert.equal(result.outcome, 'claimed')
  assert.equal(result.credit, 10)
  assert.deepEqual(result.names, ['每日签到'])
})

test('after 中重复 ID 只计一次', () => {
  const bill = { bill_id: 'same', points: 10, event_name: '每日签到' }

  const result = reconcileCheckin({ before: [], after: [bill, { ...bill }] })

  assert.equal(result.outcome, 'claimed')
  assert.equal(result.credit, 10)
})

test('before 为 null 或 undefined 时保守返回 done', () => {
  const after = [{ bill_id: 'historical', points: 100 }]

  assert.deepEqual(reconcileCheckin({ before: null, after }), done)
  assert.deepEqual(reconcileCheckin({ before: undefined, after }), done)
})

test('before 缺失时仍报告本次已实际获得的一次性奖励', () => {
  const result = reconcileCheckin({
    before: null,
    after: [{ bill_id: 'historical', points: 100 }],
    extraCredit: 30,
    extraName: '首次登录奖励'
  })

  assert.deepEqual(result, {
    outcome: 'claimed',
    credit: 30,
    message: '首次登录奖励 +30',
    names: ['首次登录奖励']
  })
})

test('多笔新账单求和且事件名去重', () => {
  const result = reconcileCheckin({
    before: [],
    after: [
      { bill_id: 'a', points: 10, event_name: '每日签到' },
      { bill_id: 'b', points: 15, event_name: '每日签到' },
      { bill_id: 'c', points: 5.9, event_name: '任务奖励' }
    ]
  })

  assert.deepEqual(result, {
    outcome: 'claimed',
    credit: 30,
    message: '每日签到 + 任务奖励 +30',
    names: ['每日签到', '任务奖励']
  })
})

test('一次性奖励未入账时叠加，已由新 reward_grant 入账时不双计', () => {
  const daily = { bill_id: 'daily', points: 10, event_name: '每日签到' }
  const reward = {
    bill_id: 'reward',
    biz_type: 'reward_grant',
    points: 20,
    event_name: '首次登录奖励'
  }

  const added = reconcileCheckin({ before: [], after: [daily], extraCredit: 20, extraName: '首次登录奖励' })
  assert.equal(added.credit, 30)
  assert.deepEqual(added.names, ['每日签到', '首次登录奖励'])

  const notDoubled = reconcileCheckin({
    before: [],
    after: [daily, reward],
    extraCredit: 20,
    extraName: '额外奖励'
  })
  assert.deepEqual(notDoubled, {
    outcome: 'claimed',
    credit: 30,
    message: '每日签到 + 首次登录奖励 +30',
    names: ['每日签到', '首次登录奖励'],
    hasNewRewardBill: true
  })
})

test('没有新增正积分账单时返回 done', () => {
  const existing = { bill_id: 'existing', points: 10, event_name: '每日签到' }

  assert.deepEqual(reconcileCheckin({ before: [existing], after: [existing] }), done)
  assert.deepEqual(reconcileCheckin({ before: [], after: [] }), done)
})

test('零积分、负积分和无效积分均忽略', () => {
  const result = reconcileCheckin({
    before: [],
    after: [
      { bill_id: 'zero', points: 0 },
      { bill_id: 'negative', points: -10 },
      { bill_id: 'invalid', points: '无效' },
      { bill_id: 'missing' }
    ],
    extraCredit: 0
  })

  assert.deepEqual(result, done)
})

test('pointsOf 与 hasRewardBill 可适配其他账单字段', () => {
  const result = reconcileCheckin({
    before: [],
    after: [
      { id: 'a', amount: 8, kind: 'daily' },
      { id: 'b', amount: 12, kind: 'reward' }
    ],
    keyOf: item => item.id,
    pointsOf: item => item.amount,
    hasRewardBill: item => item.kind === 'reward',
    extraCredit: 12
  })

  assert.equal(result.credit, 20)
  assert.equal(result.hasNewRewardBill, true)
})

// ---- 每日领取（claim）：3012 短路 / 营销回执 / 活跃上报 / 两个来源合并 ----------
//
// 这五条语义来自 Gitee iJetLi/deepseek-harness-codearts 的 zcode 签到实现：
//   src/zcode-auth.ts      claimDailyWith（1467-1600）、claimOnePlan（1630-1786）、
//                          toClaimOutcome（2171 起）、isClaimUnusualActivity（2352）
//   src/zcode-upstream.ts  reportZcodeActivation(840)、fetchZcodeClaimablePlans(864)、
//                          fetchZcodeMarketingPlans(1177)、reportZcodeMarketingAction(1227)、
//                          mergeZcodeClaimablePlans(1269)、claimZcodePlan(1308)
// 只对齐语义：不产 captcha（3007 仍是 captcha），outcome 词表仍是
// claimed / done / inactive / captcha / ineligible / failed。

const realFetch = globalThis.fetch
const nowSeconds = Math.trunc(Date.now() / 1000)
const token = ['{}', JSON.stringify({ exp: nowSeconds + 3600 })].map((s) => Buffer.from(s).toString('base64url')).join('.') + '.synthetic'
const account = { jwt: token, device: '11111111-2222-4333-8444-555555555555' }

// ok / refusal are ZCode's two reply shapes: a body wrapped in {code, data},
// and a claim's {code, msg} under its own HTTP status.
const ok = (data) => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } })
const refusal = (code, msg, status = 200) => new Response(JSON.stringify({ code, msg }), { status, headers: { 'content-type': 'application/json' } })
const failedRead = () => new Response('', { status: 502 })

const plan = (id) => ({ plan_id: id, name: `plan ${id}` })
// delivery is one marketing feed banner: its plan comes from the button's
// claim_zcode_plan action, its campaign id from the delivery itself.
const delivery = (campaign, id) => ({ campaign_id: campaign, banner: { buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: id } } }] } })

// upstream is a fake ZCode: every path a check-in asks for has a default,
// and a test overrides the ones it is about. Returns the calls it saw, so a
// test can assert on what was (and was not) sent.
function upstream(routes = {}) {
  const calls = []
  const table = {
    '/api/v1/event/report': () => ok({}),
    '/api/v1/client/configs': () => ok({}),
    '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [] }),
    '/api/v1/marketing/touch': () => ok({ deliveries: [] }),
    '/api/v1/zcode-plan/billing/claim': () => ok({}),
    '/api/v1/marketing/touch/action': () => ok({}),
    ...routes,
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const seen = { method: init.method ?? 'GET', url, headers: new Headers(init.headers ?? {}), body: init.body === undefined ? undefined : JSON.parse(init.body) }
    calls.push(seen)
    return (await table[url.pathname]?.(seen)) ?? new Response('', { status: 404 })
  }
  return calls
}
const claims = (calls) => calls.filter((c) => c.url.pathname === '/api/v1/zcode-plan/billing/claim').map((c) => c.body.plan_id)
const receipts = (calls) => calls.filter((c) => c.url.pathname === '/api/v1/marketing/touch/action').map((c) => c.body)
const reports = (calls) => calls.filter((c) => c.url.pathname === '/api/v1/event/report')

beforeEach(() => {
  // the account's rate-limit hold and zcode.z.ai's client config are both
  // module-level: one test's must not answer the next one's
  resetRateWait()
  resetClientConfigs()
  // 验证码解法是浏览器：单测里默认还原成「没有解法」，需要的用例自己注入
  setCaptchaSolver(null)
})
afterEach(() => {
  globalThis.fetch = realFetch
})

// ① 3012 = 账号级风控，必须短路
test('3012 是账号级风控：第一个 plan 撞上后不再发剩余 plan', async () => {
  const calls = upstream({
    '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [plan('p1'), plan('p2')] }),
    '/api/v1/zcode-plan/billing/claim': () => refusal(3012, 'request has been blocked due to unusual activity.', 405),
  })

  const out = await claimDaily(account)

  // ★ 只发了第一发：连发剩余 plan 就是一次点击连撞 N 次风控
  assert.deepEqual(claims(calls), ['p1'])
  assert.equal(out.outcome, 'failed')
  // ★ 风控不带 until：magpie 会按 until 重试，而重试正是加重冷却
  assert.equal(out.until, undefined)
  // 文案说清「账号级风控、冷却 30 分钟起、别连续重试」
  assert.match(out.message, /risk control/)
  assert.match(out.message, /unusual activity/)
  assert.match(out.message, /30 minutes/)
  assert.match(out.message, /don't retry/)
  // 没领到就不发回执
  assert.deepEqual(receipts(calls), [])
})

// 对照组：3007 方向相反（换个新 param 就能过），不得被 3012 的短路带走
test('3007 不短路：每个 plan 都发，且文案里没有风控措辞', async () => {
  const calls = upstream({
    '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [plan('p1'), plan('p2')] }),
    '/api/v1/zcode-plan/billing/claim': () => refusal(3007, 'captcha verify failed', 400),
  })

  const out = await claimDaily(account)

  assert.deepEqual(claims(calls), ['p1', 'p2'])
  assert.equal(out.outcome, 'captcha')
  assert.doesNotMatch(out.message, /risk control/)
  assert.deepEqual(receipts(calls), [])
})

// ② 营销回执（confirm）
test('营销回执：领到的 plan 带 campaign id 时发一次 confirm', async () => {
  const calls = upstream({ '/api/v1/marketing/touch': () => ok({ deliveries: [delivery('c-1', 'p1')] }) })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'claimed')
  assert.deepEqual(receipts(calls), [{ campaign_id: 'c-1', action_type: 'confirm' }])
})

test('营销回执：1003（已领取）仍要回执 —— 那正是「已处理完」', async () => {
  const calls = upstream({
    '/api/v1/marketing/touch': () => ok({ deliveries: [delivery('c-1', 'p1')] }),
    '/api/v1/zcode-plan/billing/claim': () => refusal(1003, 'target already exists'),
  })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'done')
  assert.equal(receipts(calls).length, 1)
})

test('营销回执：没领到（1005）时绝不发 confirm', async () => {
  const ends = Math.trunc(Date.now() / 1000) + 3600
  const calls = upstream({
    '/api/v1/marketing/touch': () => ok({ deliveries: [delivery('c-1', 'p1')] }),
    '/api/v1/zcode-plan/billing/claim': () =>
      new Response(JSON.stringify({ code: 1005, msg: 'exceed quota limit', data: { plan: { ends_at: ends } } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  })

  const out = await claimDaily(account)

  // 1005 = 今日名额已用完：ineligible，且到 data.plan.ends_at 之前不再问
  assert.equal(out.outcome, 'ineligible')
  assert.equal(Date.parse(out.until), ends * 1000)
  assert.deepEqual(receipts(calls), [])
})

test('营销回执：回执失败不影响领取结果', async () => {
  const calls = upstream({
    '/api/v1/marketing/touch': () => ok({ deliveries: [delivery('c-1', 'p1')] }),
    '/api/v1/marketing/touch/action': () => refusal(5000, 'receipt failed'),
  })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'claimed')
  assert.equal(receipts(calls).length, 1)
})

// ③ 补活跃上报
test('补活跃上报：列 plan 之前先发 app_launch 与 app_daily_active', async () => {
  const calls = upstream({ '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [plan('p1')] }) })

  await claimDaily(account)

  // 事件名在 element_name 里（ZCode 的事件 schema），不是 event —— 写错服务端不认
  assert.deepEqual(reports(calls).map((c) => c.body.element_name), ['app_launch', 'app_daily_active'])
  assert.equal(reports(calls)[0].method, 'POST')
  assert.equal(reports(calls)[0].body.device_mid, account.device)
  assert.equal(reports(calls)[0].body.app_version, APP_VERSION)
  assert.match(reports(calls)[0].body.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.equal(reports(calls)[0].body.event_region, 'app')
  assert.equal(reports(calls)[0].body.user_id, '')
  // 先上报、后列 plan
  const firstReport = calls.findIndex((c) => c.url.pathname === '/api/v1/event/report')
  const firstList = calls.findIndex((c) => c.url.pathname === '/api/v1/zcode-plan/billing/preview')
  assert.ok(firstReport >= 0 && firstReport < firstList)
})

test('补活跃上报失败不让签到变 failed（降级为「没上报」继续）', async () => {
  // 两个列表都读到了、只是今天没有可领 —— 上报挂了不该把 inactive 变成 failed
  upstream({ '/api/v1/event/report': () => new Response('', { status: 500 }) })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'inactive')
  assert.ok(out.until)
})

// ④ preview + marketing/touch 合并去重
test('preview 与营销 feed 合并去重，campaign id 补到同名 plan 上', async () => {
  const calls = upstream({
    '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [plan('same'), plan('daily')] }),
    '/api/v1/marketing/touch': () => ok({ deliveries: [delivery('c-same', 'same'), delivery('c-feed', 'feed')] }),
  })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'claimed')
  // preview 在前、feed 补充；同一个 plan id 只领一次
  assert.deepEqual(claims(calls), ['same', 'daily', 'feed'])
  // 同名 plan 的回执用的是 feed 补上的 campaign id
  assert.deepEqual(receipts(calls), [
    { campaign_id: 'c-same', action_type: 'confirm' },
    { campaign_id: 'c-feed', action_type: 'confirm' },
  ])
})

// ⑤ 一个来源失败只是降级
test('营销 feed 挂了不影响 preview 那条主路径', async () => {
  const calls = upstream({
    '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [plan('daily')] }),
    '/api/v1/marketing/touch': () => failedRead(),
  })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'claimed')
  assert.deepEqual(claims(calls), ['daily'])
})

test('preview 挂了、feed 有 plan：feed 的照领', async () => {
  const calls = upstream({
    '/api/v1/zcode-plan/billing/preview': () => failedRead(),
    '/api/v1/marketing/touch': () => ok({ deliveries: [delivery('c-1', 'p1')] }),
  })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'claimed')
  assert.deepEqual(claims(calls), ['p1'])
})

test('两个来源都读不到才是 failed（不带 until）', async () => {
  upstream({
    '/api/v1/zcode-plan/billing/preview': () => failedRead(),
    '/api/v1/marketing/touch': () => failedRead(),
  })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'failed')
  assert.match(out.message, /plan list/)
  assert.match(out.message, /marketing feed/)
  assert.equal(out.until, undefined)
})

// ⑥ 没 plan 的文案
test('两个来源都没有 plan：inactive + 服务端按日刷新的文案', async () => {
  const calls = upstream()

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'inactive')
  assert.ok(out.until)
  assert.match(out.message, /no ZCode gift plan to claim today/)
  assert.deepEqual(claims(calls), [])
})

// 卡片那一行只读营销 feed：preview 的赠送计划没有横幅可报，而且卡片读取
// 不得多打一发（tests/usage.test.mjs 钉住了「卡片不请求 preview」）。
test('卡片那行只读营销 feed，不请求 preview', async () => {
  const calls = upstream({ '/api/v1/marketing/touch': () => ok({ deliveries: [delivery('c-1', 'p1')] }) })

  const line = await claimHint(account)

  assert.deepEqual(calls.map((c) => c.url.pathname), ['/api/v1/marketing/touch'])
  assert.equal(line.display, '1 · p1')
})

// ⑦ 每账号一个 device_mid：服务端按 device_mid + 日期 去重，共用 mid 的账号会互相顶掉
test('每账号一个 device_mid：只有 key 的账号用 key 派生稳定 id', async () => {
  const calls = upstream({ '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [] }) })

  await claimDaily({ jwt: token, key: 'sk-account-key' })

  const mid = reports(calls)[0].body.device_mid
  assert.match(mid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.equal(mid, keyDevice('sk-account-key'))
})

// 活跃上报的 user_id 是账号自己的 id（stateOf 从 magpie 的 auth 带出来）——
// 空串是服务端可能不计数的上报，preview 因此可能一直回空 plans
test('活跃上报带账号自己的 user_id', async () => {
  const calls = upstream({ '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [] }) })

  await claimDaily({ ...account, uid: 'u-42' })

  assert.equal(reports(calls)[0].body.user_id, 'u-42')
})

// preview 不是公开接口：2026-11-13 五个账号全挂在「the plan list: Unauthorized」上，
// 因为不带 Authorization 就是 HTTP 401（zcode-switch 的 preview_once 也带 JWT）
test('preview 带账号的 Authorization', async () => {
  const calls = upstream({ '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [] }) })

  await claimDaily(account)

  const preview = calls.find((c) => c.url.pathname === '/api/v1/zcode-plan/billing/preview')
  assert.equal(preview.headers.get('authorization'), 'Bearer ' + token)
})

// ⑧ 安全验证：解得出就带着参数领，解不出退回 captcha（绝不 post 一发没有参数的 claim）
const captchaConfig = { enabled: true, region: 'cn', prefix: 'prefix', sceneId: 'scene' }
const configsWith = (captcha) => ok({ configs: { captcha } })

test('安全验证开启：先解无感验证，claim 带阿里云参数', async () => {
  const calls = upstream({
    '/api/v1/client/configs': () => configsWith(captchaConfig),
    '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [plan('p1')] }),
  })
  let asked = null
  setCaptchaSolver(async (o) => {
    asked = o
    return { param: 'P-123', region: 'cn' }
  })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'claimed')
  assert.equal(asked.sceneId, 'scene')
  assert.equal(asked.region, 'cn')
  assert.equal(asked.prefix, 'prefix')
  const claim = calls.find((c) => c.url.pathname === '/api/v1/zcode-plan/billing/claim')
  assert.equal(claim.headers.get('x-aliyun-captcha-verify-param'), 'P-123')
  assert.equal(claim.headers.get('x-aliyun-captcha-verify-region'), 'cn')
})

test('解不出验证码：退回 captcha 结果，且不 post claim', async () => {
  const calls = upstream({
    '/api/v1/client/configs': () => configsWith(captchaConfig),
    '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [plan('p1')] }),
  })
  setCaptchaSolver(async () => {
    throw new Error('no browser')
  })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'captcha')
  assert.match(out.message, /no browser/)
  assert.deepEqual(claims(calls), [])
  assert.deepEqual(receipts(calls), [])
})

test('验证码配置关着：不跑浏览器，claim 不带阿里云头', async () => {
  const calls = upstream({
    '/api/v1/client/configs': () => configsWith({ enabled: false, sceneId: 'scene' }),
    '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [plan('p1')] }),
  })
  let solved = 0
  setCaptchaSolver(async () => {
    solved++
    return { param: 'x', region: '' }
  })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'claimed')
  assert.equal(solved, 0)
  const claim = calls.find((c) => c.url.pathname === '/api/v1/zcode-plan/billing/claim')
  assert.equal(claim.headers.get('x-aliyun-captcha-verify-param'), null)
})

test('验证码配置读不懂：failed，不 post claim', async () => {
  const calls = upstream({
    '/api/v1/client/configs': () => configsWith('on'),
    '/api/v1/zcode-plan/billing/preview': () => ok({ plans: [plan('p1')] }),
  })

  const out = await claimDaily(account)

  assert.equal(out.outcome, 'failed')
  assert.deepEqual(claims(calls), [])
})
