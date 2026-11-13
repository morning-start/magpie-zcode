// src/claim.mjs —— 每日领取 ZCode 的赠送计划（auth.checkin）
//
// ZCode 的赠送计划从两个列表发出来：每日赠送在 billing/preview，节日/新用户的
// 活动在营销 feed（marketing/touch）里，账号要在 ZCode App 里点领取。这里替
// 用户领：两个列表各有什么（按 plan id 去重）、领没领过（1003）、要不要求
// 安全验证（3007）、是不是限流（3002）、是不是账号级风控（3012，命中即停）。
// 领到之后还要给营销活动回执（confirm）。限流的等待记在本进程里，
// 等待期内不再打上游（magpie 的 429 退避与厂商的「频率过高」不是一回事）。
//
// 安全验证（3007）按 ZCode 客户端自己的做法办：先在 client/configs 里看它开没开，
// 开了就用受控浏览器跑一次阿里云无感验证，把 captchaVerifyParam 放进
// X-Aliyun-Captcha-Verify-Param（见 src/captcha.mjs）—— 和 zcode-switch 1.7.x
// 隐藏 Webview 的做法同一条路。解不出（没有浏览器 / 无感要人工 / 超时）才退回
// captcha 结果，让用户去 ZCode App 手动领。

import { ZCODE, APP_VERSION, UA, platform, first, keyDevice, uuid, STATUS_TEXT, jwtExpired, EXPIRED, sleep } from "./zcode.mjs"
import { call, retryAfterMs } from "./zai-call.mjs"
import { clientConfigs } from "./catalog.mjs"
import { routes } from "./plan.mjs"
import { captchaOf, solveCaptchaSerially } from "./captcha.mjs"
import os from "node:os"

// CLAIM_HINT is the claim line's name: a fixed sentence, so magpie
// translates it with the interface's own language (the plan's name and
// the count are data, and go in the display, which is shown as it came).
const CLAIM_HINT = "Gift plans to claim in the ZCode app"

// claimHint is the card's line for gift plans ZCode is holding for the
// account but has not put on it: the app's banners (marketing/touch)
// list them. The
// card only names them: they are claimed in the ZCode app, or by the
// daily claim (claimDaily) when the user turned it on; on 10-06 a claim
// without the app's Aliyun captcha attestation was refused (3007). A window, set aside (it is no
// allowance: using it up stops nothing), so the card shows it and
// routing, caps and the menu bar pass it over. The window's name is a
// fixed sentence, so magpie can translate it (a display is shown as it
// came); the count and the plan's own name go in the display. null when
// there is nothing to claim, the feed failing or listing none among
// it: a failed read is no line at all, never a card or a refusal of its
// own.
//
// The card reads the feed alone (`preview: false`): a preview gift plan
// has no banner, so there is no line to name it on — the daily claim
// (claimDaily) claims it all the same. It also keeps a card read a read
// of the feed, and one request (tests/usage.test.mjs pins the card to
// the feed).
async function claimHint(s) {
  if (!s.jwt || jwtExpired(s.jwt)) return null
  const { plans } = await toClaim(s, { preview: false })
  if (!plans.length) return null
  const n = plans.length
  const plan = first(...plans.map((p) => p.name), "ZCode gift plan")
  return { name: CLAIM_HINT, used: 0, aside: true, display: `${n} · ${plan}` }
}
// ---- the daily claim ---------------------------------------------------------------

// CLAIMED_ALREADY is /billing/claim's body code for a plan the account
// has claimed before: HTTP 200 {"code":1003,"msg":"target already
// exists"} (magpie-community/plugins#503, a real reply), the desktop
// app's manualClaimPlan.claim.failure.alreadyClaimed. CAPTCHA is its
// answer to a claim without the Aliyun captcha attestation the ZCode app's
// renderer makes: HTTP 400 {"code":3007,"msg":"captcha verify failed"}
// (seen 10-06, #30).
const CLAIMED_ALREADY = 1003
const CAPTCHA = 3007
// UNUSUAL_ACTIVITY is ZCode's answer to an account its risk control has
// flagged: HTTP 405 {"code":3012,"msg":"request has been blocked due to
// unusual activity."} (Gitee iJetLi/deepseek-harness-codearts,
// src/zcode-diagnostics.ts 的 isZcodeUnusualActivityCode /
// formatZcodeUnusualActivityMessage，两个入口共用同一份文案 ——
// 推理侧 src/zcode-adapter.ts 与领取侧 src/zcode-auth.ts 曾各写一份而漂移)。
// 它是**账号级**的：冷却 30 分钟起步，反复触发会升级到 24 小时乃至停用。
// 所以命中它的签到**不再发剩余 plan**（一次点击连发 N 个 plan = 连撞 N 次
// 风控），也不带 `until`（magpie 会按 `until` 重试，而重试正是加重冷却的
// 动作）。3007 与它方向相反：3007 换个新 param 就能过，3012 再发只会更糟。
const UNUSUAL_ACTIVITY = 3012
const UNUSUAL_ACTIVITY_CLAIM = "ZCode's risk control blocked this account for unusual activity (code 3012); the cooldown starts at 30 minutes and asking again raises it to 24 hours or a block, so don't retry one after another"
// NOT_ELIGIBLE is /billing/claim's body code for a plan the account is not
// offered at that moment: HTTP 400 {"code":1004,…}. A stale APP_VERSION
// answers it for every account at once (11-04: six accounts all answered
// 1004 under 3.16.3's header, and four of them claimed with code 0 under
// 3.17.2's, one night, with nothing else changed).
const NOT_ELIGIBLE = 1004
// QUOTA_EXHAUSTED is /billing/claim's body code for a plan whose daily
// quota is used up: HTTP 400 {"code":1005,"msg":"exceed quota limit"}.
// The answer carries data.plan.ends_at — when the quota resets — which is
// the earliest ask worth making; zcode-switch maps it to nextAt the same
// way (claim.rs's claim_error). Asking again before it only spends the
// account's standing with ZCode's risk control.
const QUOTA_EXHAUSTED = 1005
// RATE_LIMITED is Z.ai's "请求过于频繁" body code, its answer (with HTTP
// 429) to a client that asked too often. #503 (MiniFullC, 11-04) read 180
// "gift plans to claim: Too Many Requests" over four days at magpie's
// 30-minute retry, so asking again the same half hour keeps the limit on.
// magpie asks a failed again once retryAfter() has passed, whatever the
// answer's `until` says (the contract reads `until` as when an answer
// stops standing, not as the earliest time to ask again), so the account
// is held here instead: while the wait lasts, claimDaily answers the same
// failed again, `until` and all, and asks ZCode nothing. A Retry-After
// ZCode sent is honored up to RATE_LIMIT_MAX_MS; without one the
// account's own wait doubles from RECHECK_MS, and a read that comes
// through forgets it.
const RATE_LIMITED = 3002
const RATE_LIMIT_MAX_MS = 6 * 60 * 60_000
const rateWait = new Map() // s.key -> { ms, until, message }: the hold this account is under
// resetRateWait is for tests: it forgets the holds, and with `expire` it
// back-dates them, standing where the wait has passed. The plugin itself
// forgets a hold by reading through or by waiting it out, never by calling
// this.
function resetRateWait(expire = false) {
  if (!expire) {
    rateWait.clear()
    return
  }
  for (const [k, h] of rateWait) rateWait.set(k, { ...h, until: new Date(Date.now() - 1).toISOString() })
}
// holdKey names the account a wait belongs to. stateOf gives key: "" to a
// sign-in that has a jwt and no API key — the Start-Plan-only sign-ins
// that claim gift plans, #503's case — so the key alone would put every
// one of them under a single hold, and one account's 429 would answer for
// all of them. The jwt tells them apart; a renewed token starting its own
// wait is fine.
const holdKey = (s) => s.key || s.jwt
// retryAfterMs is a Retry-After header, in seconds or as an HTTP date, in
// ms; 0 when there is none or it doesn't read.
// noteRateLimit remembers the wait this account is under, with the failed
// that wait answers with, and says when it ends: a Retry-After ZCode sent
// is taken as it is, up to the cap; without one the wait doubles from
// RECHECK_MS (and never falls below it), so a client ZCode keeps turning
// away asks less and less.
function noteRateLimit(key, saidMs, message) {
  const last = rateWait.get(key)?.ms ?? 0
  const want = saidMs > 0 ? saidMs : Math.max(RECHECK_MS, last * 2)
  const ms = Math.min(RATE_LIMIT_MAX_MS, want)
  const until = new Date(Date.now() + ms).toISOString()
  rateWait.set(key, { ms, until, message })
  return until
}
const CAPTCHA_WORDS = /captcha/i

// claimNeedsCaptcha says whether ZCode's claims want its security check
// now, from what client/configs says: its captcha (Aliyun's, which the
// ZCode app passes before every claim, invisibly as a rule, and sends as
// X-Aliyun-Captcha-Verify-Param, 3.17.2's requestVerificationClaimHeaders)
// switched on. No captcha in the configs is no check, as the app reads it
// (readRequestVerificationConfig gives null, and the claim goes without
// the header); one that isn't an object is unknown, null.
// skip_model_request is the same check for Start Plan requests, which it
// spares (true on 11-07); it is not read here.
function claimNeedsCaptcha(c) {
  const k = c?.configs?.captcha
  if (k == null) return false
  if (typeof k !== "object" || Array.isArray(k)) return null
  return k.enabled !== false
}
// CAPTCHA_CLAIM is said when ZCode wants its security check but it can't be
// passed here (no Chromium on the machine, or a config with no scene): the
// plans are named, and the one right action is the app.
const CAPTCHA_CLAIM = "claim it in the ZCode app: ZCode asks its security check before a claim, and this machine can't pass it"
// CAPTCHA_TIMEOUT_MS is the whole solve's cap (browser start, page, the
// traceless wait). A check-in that hangs past it is a failed one, not a
// stuck account.
const CAPTCHA_TIMEOUT_MS = 45_000
// captchaSolver makes the proof a claim with security on posts; it is
// src/captcha.mjs's browser run, and setCaptchaSolver swaps it for tests
// (a real browser is no part of a unit test).
let captchaSolver = solveCaptchaSerially
function setCaptchaSolver(fn) {
  captchaSolver = typeof fn === "function" ? fn : solveCaptchaSerially
}

// The marketing feed and the claim are gated on the client's version:
// under an older version's header the feed answers empty (11-03, #678:
// the day's banner showed for 3.17.2 and for no older one), so they go,
// as every call does, as the current client (APP_VERSION) sends them.
const marketingHeaders = () => ({ "X-ZCode-App-Version": APP_VERSION, "X-Platform": platform(), "X-Client-Language": clientLanguage() })

// claimOne asks /billing/claim for one plan and says what its body says:
// "claimed" (code 0), "done" (code 1003, claimed before), "captcha" (the
// claim wants the app's captcha), else "failed" with why. Only a body
// that reads decides: an HTTP error without one, or text that isn't
// JSON, is failed (unknown), never claimed. Only the code is read (#503
// has a real code 0 reply, "Plan claimed successfully.").
//
// `proof` is the Aliyun captcha parameter (src/captcha.mjs), or null
// when ZCode's configs say claims go without one: it goes in
// X-Aliyun-Captcha-Verify-Param, and its region in
// X-Aliyun-Captcha-Verify-Region, as the ZCode client sends them
// (zcode-switch's submit_claim).
// endsAt reads a claim's data.plan.ends_at (seconds) as an ISO time: a
// 1005's wait ends there, and the card says when the plan's allowance
// starts and stops (data.plan.starts_at / ends_at).
const endsAt = (env) => {
  const s = Number(env?.data?.plan?.ends_at)
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : undefined
}
async function claimOne(s, planID, proof = null) {
  let res, text
  try {
    res = await fetch(`${ZCODE}/api/v1/zcode-plan/billing/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UA,
        Authorization: "Bearer " + s.jwt,
        "X-Device-Mid": deviceOf(s),
        ...(proof?.param
          ? { "X-Aliyun-Captcha-Verify-Param": proof.param, ...(proof.region ? { "X-Aliyun-Captcha-Verify-Region": proof.region } : {}) }
          : {}),
        ...marketingHeaders(),
      },
      body: JSON.stringify({ plan_id: planID }),
    })
    text = await res.text()
  } catch (e) {
    return { outcome: "failed", why: e?.message ?? String(e) }
  }
  let env
  try {
    env = JSON.parse(text)
  } catch {}
  const code = env && typeof env === "object" && env.code != null && String(env.code).trim() !== "" ? Number(env.code) : NaN
  const msg = typeof env?.msg === "string" ? env.msg : ""
  // a rate limit is no claim: it is said as one, and carries how long to wait
  if (res.status === 429 || code === RATE_LIMITED) return { outcome: "failed", why: `${msg || STATUS_TEXT[429]} (HTTP ${res.status}${Number.isFinite(code) ? `, code ${code}` : ""})`, rate: retryAfterMs(res) }
  if (code === CAPTCHA || CAPTCHA_WORDS.test(msg)) return { outcome: "captcha", why: msg || `code ${code}` }
  // 3012 不是这一个 plan 的失败，是账号被风控：文案说清冷却与「别连续重试」，
  // 并打上 blocked 让 claimDaily 短路（见 UNUSUAL_ACTIVITY）。放在 3007 之后、
  // 1003 之前，与上游 toClaimOutcome 的分支顺序一致。
  if (code === UNUSUAL_ACTIVITY) return { outcome: "failed", why: UNUSUAL_ACTIVITY_CLAIM, blocked: true }
  if (code === CLAIMED_ALREADY) return { outcome: "done" }
  if (code === QUOTA_EXHAUSTED) return { outcome: "ineligible", why: msg || `code ${code}`, until: endsAt(env) }
  if (code === NOT_ELIGIBLE) return { outcome: "ineligible", why: msg || `code ${code}` }
  if (code === 0 && res.ok) return { outcome: "claimed" }
  if (!Number.isFinite(code)) return { outcome: "failed", why: `HTTP ${res.status}, unreadable reply ${String(text ?? "").trim().slice(0, 120) || "(empty)"}` }
  return { outcome: "failed", why: `${msg || "error"} (HTTP ${res.status}, code ${code})` }
}

// TOUCH is ZCode's marketing feed: the ZCode app's claim banners come
// from it. A banner plan ("ZCODE WEEKEND BUILD", 10-30) is served only
// while the app shows its banner, and the app claims it through the same
// /billing/claim (#503's capture of 10-30, kongbai01203: GET
// /api/v1/marketing/touch?seq=<n, counting up from 0> with the session,
// X-Device-Mid, X-Client-Language and X-ZCode-App-Version, answered
// data.deliveries[].banner.buttons[].action = {"type":"claim_zcode_plan",
// "args":{"plan_id":…}} and the plan's name in
// banner.background.args.zcode_plan.name). This feed only **supplements**
// the preview (see PREVIEW): a campaign plan (1024's five hundred million
// tokens) is in the feed alone, while the day's gift plan is in the
// preview alone, so a check-in that reads one list misses the other
// (Gitee iJetLi/deepseek-harness-codearts, src/zcode-upstream.ts's
// fetchZcodeMarketingPlans + mergeZcodeClaimablePlans). A rewards
// center's gift lives on the rewards website, outside this API, and is
// claimed in the client.
const TOUCH = "/api/v1/marketing/touch"
// PREVIEW is ZCode's daily gift plans: GET
// /api/v1/zcode-plan/billing/preview?app_version=…&platform=…, answered
// data.plans[].plan_id. It is the main list (a daily gift plan is
// claimed with no banner). It is **not** public: without the account's
// Authorization it answers HTTP 401 (2026-11-13, all five accounts), so
// it goes with the same billing headers as the claim (zcode-switch's
// preview_once sends the JWT too).
const PREVIEW = "/api/v1/zcode-plan/billing/preview"
// CLAIM_ACTION is the marketing feed's claim button: a delivery's
// buttons[].action = {"type":"claim_zcode_plan","args":{"plan_id":…}}.
const CLAIM_ACTION = "claim_zcode_plan"
// MARKETING_ACTION is the feed's receipt endpoint: POST
// /api/v1/marketing/touch/action {campaign_id, action_type}. The app's
// renderer sends "confirm" right after a campaign's plan is claimed; a
// campaign never confirmed is put back every round (confirmPlan).
const MARKETING_ACTION = "/api/v1/marketing/touch/action"
// EVENT_REPORT is the client's own activity report: POST
// /api/v1/event/report {event, device_mid, platform, app_version}. ZCode
// hands out the day's plans by it: before the two events
// (ACTIVATION_EVENTS) are reported its preview answers empty plans, and
// after them the day's gift plan (reportActivation).
const EVENT_REPORT = "/api/v1/event/report"
const ACTIVATION_EVENTS = ["app_launch", "app_daily_active"]
// touchSeq is the feed's seq: ZCode's own count of its feed requests
// since the process started, from 0, one GET per refresh. It is not a
// page: "仅供服务端日志定位，不改变投放判断" (docs/marketing-touch-client.md,
// marketingTouchService.ts's bootRequestSeq, zai-org/ZCode@a9fe401), so a
// check-in asks once, never seq 0..8 in a row (plugins#676), and a banner
// seen at one seq and not another is a delivery arriving later.
let touchSeq = 0
// clientLanguage is the language ZCode names to marketing/touch: zh-CN or
// en-US, its two UI languages, never another (marketingTouchService's
// localeSchema), so a computer set to zh-Hans-CN or en-GB asks as ZCode does.
const clientLanguage = () => {
  let l = ""
  try {
    l = Intl.DateTimeFormat().resolvedOptions().locale || ""
  } catch {}
  return /^zh\b/i.test(l) ? "zh-CN" : "en-US"
}
// deviceOf is the machine id an account's calls carry: the sign-in's saved
// device, or — a key-only sign-in, which has none — a UUID made from the
// key, the same one on every start. One account, one id: ZCode's server
// dedupes by device_mid and date, so accounts sharing a mid claim each
// other's plans (zcode-switch gives each account its own virtual mid for
// exactly this reason, store.rs's ensure_virtual_device_mid).
const deviceOf = (s) => s.device || keyDevice(s.key || s.jwt || "")
// clientTimezone is the IANA zone ZCode's event report names. It is not
// read for anything else, and an unknown zone is still a value the report
// takes, so a broken Intl is no reason to fail the check-in.
const clientTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}
// osCategory is ZCode's own name for the OS in its event report:
// windows / macos / linux, not Node's win32 / darwin / linux.
const osCategory = () => (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux")
const osVersion = () => {
  try {
    return os.release()
  } catch {
    return ""
  }
}

// touchPlans is the plans marketing/touch's deliveries offer to claim:
// [{plan_id, name, campaign_id?}], [] for a feed with no deliveries,
// null for one that doesn't read. Each delivery is searched for its
// claim_zcode_plan actions and its zcode_plan's name, wherever the
// banner keeps them, so a button moved inside the banner is still found.
// The delivery's campaign_id comes along: it is what the claim's receipt
// (confirmPlan) is sent for.
function touchPlans(d) {
  if (d == null) return []
  if (typeof d !== "object" || Array.isArray(d)) return null
  if (d.deliveries == null) return []
  if (!Array.isArray(d.deliveries)) return null
  const out = []
  for (const dv of d.deliveries) {
    const ids = [], names = []
    const walk = (v, depth) => {
      if (!v || typeof v !== "object" || depth > 12) return
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1))
      if (v.type === CLAIM_ACTION && typeof v.args?.plan_id === "string" && v.args.plan_id.trim()) ids.push(v.args.plan_id.trim())
      if (v.zcode_plan && typeof v.zcode_plan === "object" && typeof v.zcode_plan.name === "string") names.push(v.zcode_plan.name)
      for (const k of Object.keys(v)) walk(v[k], depth + 1)
    }
    walk(dv, 0)
    const campaign = typeof dv?.campaign_id === "string" ? dv.campaign_id.trim() : ""
    for (const id of ids) out.push({ plan_id: id, name: first(names[0] ?? "", id), ...(campaign ? { campaign_id: campaign } : {}) })
  }
  return out
}

// previewPlans is the plans billing/preview offers to claim:
// [{plan_id, name, priority}], [] for a reply naming no plan, null for one
// that doesn't read. Only plan_id, name and priority are read: the amount
// the preview also carries is no part of auth.checkin's answer (magpie's
// window, not this hook, counts allowance), and an unread reply is
// unknown, never none.
//
// The list keeps ZCode's own priority, highest first: the app shows the
// plans in that order, and a plan claimed first is the one the day's
// quota was kept for (zcode-switch sorts by priority the same way,
// claim.rs's preview_once).
function previewPlans(d) {
  if (d == null) return []
  if (typeof d !== "object" || Array.isArray(d)) return null
  if (d.plans == null) return []
  if (!Array.isArray(d.plans)) return null
  const out = []
  for (const p of d.plans) {
    if (!p || typeof p !== "object" || Array.isArray(p)) continue
    if (typeof p.plan_id !== "string" || !p.plan_id.trim()) continue
    const priority = Number(p.priority)
    out.push({ plan_id: p.plan_id.trim(), name: first(p.name, p.plan_id.trim()), priority: Number.isFinite(priority) ? priority : 0 })
  }
  // highest priority first; same priority keeps ZCode's own list order
  // (Array.sort is stable), which is the order the app shows them in
  out.sort((a, b) => b.priority - a.priority)
  return out
}

// toClaim is every gift plan the account can claim, from both lists
// ZCode hands them out in: the preview (the day's gift plan) first, the
// marketing feed (the app's campaign banners) beside it, deduped by plan
// id — a plan both lists name is claimed once. A plan the feed also names
// keeps the preview's fields (they are the ones read before) and takes
// the feed's campaign_id, which is what its receipt (confirmPlan) goes
// out for (Gitee iJetLi/deepseek-harness-codearts,
// src/zcode-upstream.ts's mergeZcodeClaimablePlans: preview wins, the
// campaign id is filled in).
//
// unread names a list that didn't read: its plans are unknown, never
// none, and claimDaily fails (asks again) when no plan was read at all.
// One list failing is **not** the other's failure — ZCode's preview and
// its marketing feed fail apart, and a check-in that read the day's gift
// plan must not be undone by a banner feed that was down (the same
// degradation the reference has, "营销 feed 失败降级为 []").
//
// `preview: false` reads the feed alone: that is the card's line
// (claimHint), which names the app's banners — a preview gift plan has no
// banner to name, and a card read stays a read of the feed (a card read
// posts no preview request; tests/usage.test.mjs pins it).
async function toClaim(s, { preview: withPreview = true } = {}) {
  const plans = [], unread = []
  let rate = null
  const add = (p) => {
    const at = plans.findIndex((q) => q.plan_id === p.plan_id)
    if (at < 0) {
      plans.push({ ...p })
      return
    }
    if (plans[at].campaign_id === undefined && p.campaign_id !== undefined) plans[at] = { ...plans[at], campaign_id: p.campaign_id }
  }
  const read = async (label, fetchPlans) => {
    let got
    try {
      got = await fetchPlans()
    } catch (e) {
      unread.push(`gift plans to claim: ${label}: ${e?.message ?? String(e)}`)
      // rate is the ms ZCode asked to wait (0 when it sent no
      // Retry-After), null when this was not a rate limit at all
      if (rate === null && (e?.status === 429 || e?.code === RATE_LIMITED)) rate = e.retryAfterMs || 0
      return
    }
    if (!got) {
      unread.push(`gift plans to claim: ${label} doesn't read`)
      return
    }
    got.forEach(add)
  }
  if (withPreview) await read("the plan list", () => call("GET", `${ZCODE}${PREVIEW}?app_version=${APP_VERSION}&platform=${platform()}`, { auth: "Bearer " + s.jwt, device: deviceOf(s), headers: marketingHeaders() }).then(previewPlans))
  await read("the marketing feed", () => call("GET", `${ZCODE}${TOUCH}?seq=${touchSeq++}`, { auth: "Bearer " + s.jwt, device: deviceOf(s), headers: marketingHeaders() }).then(touchPlans))
  return { plans, unread, rate }
}

// reportActivation tells ZCode the client was started and used today —
// the two events its gift plans depend on. The server does not push a
// plan on its own schedule: before these two POSTs its preview answers
// an empty plans, and after them the day's gift plan (Gitee
// iJetLi/deepseek-harness-codearts, src/zcode-upstream.ts's
// reportZcodeActivation — "不补这两条事件，preview 恒为空 plans: [] ⇒
// 用户以为签到坏了"; the events are idempotent, the server deduping by
// device_mid and date, so every ask may report them).
//
// A report that fails is **not** the check-in's failure: it is reported
// again on the next ask, and a failed report must never turn a claim into
// a failed one — so each event is its own try, and nothing is said about
// it.
//
// The body is ZCode's own event schema, field for field: the app's
// reportActivationEvent (zcode-switch's claim.rs activation_event_body).
// The two fields that decide whether the server counts it are
// `element_name` (the event's name — a body that sends `event` instead is
// a body the server ignores, and the day's plans never appear) and
// `event_id` (a fresh UUID per report; the server dedupes by it and by
// device_mid + date). `user_id` is the account's own id, `device_mid` its
// virtual one (deviceOf), and the OS is named the way ZCode names it
// (windows / macos / linux), not the way Node does.
async function reportActivation(s) {
  const device = deviceOf(s)
  for (const event of ACTIVATION_EVENTS) {
    try {
      await call("POST", `${ZCODE}${EVENT_REPORT}`, {
        device,
        headers: marketingHeaders(),
        body: {
          event_id: uuid(),
          client_timezone: clientTimezone(),
          client_language: clientLanguage(),
          element_name: event,
          event_region: "app",
          event_type: "view",
          event_text: "",
          event_extra_detail: {},
          user_id: String(s.uid ?? "").trim(),
          screen_resolution: "2560x1440",
          app_version: APP_VERSION,
          device_os_category: osCategory(),
          device_os_version: osVersion(),
          device_mid: device,
          mac_id: "",
          marketing_params: "{}",
        },
      })
    } catch {}
  }
}

// confirmPlan takes the marketing feed's receipt for a plan that was
// claimed (code 0) or had been (1003): POST /marketing/touch/action
// {campaign_id, action_type: "confirm"}. The app's renderer sends it
// right after the action lands, and without it the server keeps putting
// the same campaign back — every check-in would claim a plan it already
// has (Gitee iJetLi/deepseek-harness-codearts, src/zcode-upstream.ts's
// reportZcodeMarketingAction).
//
// Only a plan the feed named a campaign for has one to send; a claim
// that did not land (3012 / 3007 / failed) never sends one — confirm
// means "this campaign is done with me", so on a failure it would cost
// the user the plan ("别再给我看了 ⇒ 用户白丢一次领取机会"; cancel is
// never sent either). The reply is not part of the claim's answer: a
// receipt that fails is no claim's failure, and is only not recorded.
async function confirmPlan(s, p) {
  if (typeof p.campaign_id !== "string" || !p.campaign_id) return false
  try {
    await call("POST", `${ZCODE}${MARKETING_ACTION}`, {
      auth: "Bearer " + s.jwt,
      device: s.device,
      headers: marketingHeaders(),
      body: { campaign_id: p.campaign_id, action_type: "confirm" },
    })
    return true
  } catch {
    return false
  }
}

// RECHECK is how long an "nothing to claim" stands before magpie's loop
// asks again: ZCode drops gift plans into the feed during the day (a
// weekend banner, say) on its own schedule, and the day's ask
// may have run hours before, so an inactive settled for the day lets a
// plan sit unclaimed past its short life (the weekend plan of
// testdata/touch-1030-wk.json starts 19:00 Beijing). `until` wakes the
// loop again in half an hour, and it asks again all day while neither
// list names a plan — two GETs and no claim posted. The other settled
// answers stand for the day: a claimed plan leaves the feed, so asking
// a claimed account again half an hour later finds nothing and flips
// its card from "Checked in today" to "No check-in event now"; a
// captcha plan re-asked makes ZCode demand its captcha again each time,
// and a done plan re-asked posts a claim it already answered 1003. The
// same shape as Qoder's campaign that opens mid-day, asked again on
// magpie's side there (yetone/magpie#2696). A failed needs no until:
// magpie asks a failed again after 30 minutes of its own.
const RECHECK_MS = 30 * 60_000
const recheck = () => new Date(Date.now() + RECHECK_MS).toISOString()
// NO_PLAN_TODAY is said when both lists read and neither names a plan.
// It says what was observed — never "already claimed today", which would
// be a lie (a day's plan not yet handed out has used_units 0) — and
// gives the one right action: come back later, the server hands the day's
// plans out as the day goes on. The reference says the same in the same
// place (Gitee iJetLi/deepseek-harness-codearts, src/zcode-auth.ts's
// claimDailyWith: "今日暂无可领额度（服务端按日刷新）").
const NO_PLAN_TODAY = "no ZCode gift plan to claim today (ZCode hands the day's plans out as the day goes on)"

// claimDaily claims every gift plan ZCode offers the account (#503:
// toClaim, the preview's daily gift plans and the app's marketing
// banners), as auth.checkin's answer: inactive when neither lists one,
// claimed when one was claimed now, done when each was claimed before,
// captcha when ZCode wants the app's captcha for one (it is claimed in
// the ZCode app), ineligible when ZCode is not offering one at that
// moment (code 1004, read again later in the day), failed when no list
// reads, when a claim can't be read, or when ZCode's risk control has
// blocked the account (3012 — see UNUSUAL_ACTIVITY: no plan is posted
// after it, and it carries no `until`).
// The client's activity is reported before the lists are asked for:
// ZCode hands the day's plans out by it (reportActivation), and a report
// that fails is no claim's failure. A list that didn't read is no
// failure either while the other read a plan — one list being down must
// not undo the day's claim.
// A rate-limited read (HTTP 429, or code 3002)
// is not asked again either: the account is held here until the wait ends
// (a Retry-After ZCode sent, else the account's own wait doubling from
// RECHECK_MS, out to RATE_LIMIT_MAX_MS — see RATE_LIMITED), and every ask
// inside the wait answers the failed it already gave, without a request.
// The hold belongs to one account (`s.key || s.jwt`) and lives in this
// process's memory alone: a magpie restart forgets it. magpie from
// v0.1.3165 honors a failed's `until` itself; older versions wait for
// this hold, which is why it stays.
// A failed one is asked again later in the
// day, when a plan claimed now answers 1003. An inactive stands only
// until RECHECK_MS from now, so a plan dropped into the feed later in
// the day is still claimed; the other settled answers stand for the day
// (see RECHECK).
// Nothing here marks the account: a failed claim keeps its sign-in.
async function claimDaily(s) {
  if (!s?.jwt) return { outcome: "ineligible", message: "ZCode's gift plans are claimed with a ZCode sign-in; this account has none" }
  if (jwtExpired(s.jwt)) return { outcome: "failed", message: EXPIRED }
  // a rate limit this account is still under: the same failed again, and
  // not one request (magpie asks a failed again after 30 minutes of its
  // own, so holding it is the plugin's job — see RATE_LIMITED)
  const held = rateWait.get(holdKey(s))
  if (held && Date.now() < Date.parse(held.until)) return { outcome: "failed", message: held.message, until: held.until }
  // the client's activity, before the plans are asked for: without it the
  // preview answers an empty list and the check-in says "nothing to claim"
  // on a day ZCode has a plan (reportActivation)
  await reportActivation(s)
  const { plans, unread, rate = null } = await toClaim(s)
  // a rate-limited read: held here until the wait is over
  if (rate !== null) {
    const message = unread.join("; ") || "ZCode rate limited this account"
    return { outcome: "failed", message, until: noteRateLimit(holdKey(s), rate, message) }
  }
  // both lists answered and no claim is read: the wait is over. It is not
  // forgotten before the claims below, so a claim ZCode keeps limiting
  // waits longer each time (see noteRateLimit)
  if (!plans.length) {
    rateWait.delete(holdKey(s))
    return unread.length
      ? { outcome: "failed", message: unread.join("; ") }
      : { outcome: "inactive", message: NO_PLAN_TODAY, until: recheck() }
  }
  // ZCode's security check for claims, read before any is posted: its
  // client/configs says whether claims want one (captchaOf). When they do,
  // the proof is made first — a controlled Chromium runs Aliyun's
  // traceless verification (src/captcha.mjs), the same way the ZCode
  // client's hidden WebView does, and the claim goes with
  // X-Aliyun-Captcha-Verify-Param; a claim without it only answers 3007.
  // A check that can't be passed (no browser, a person needed, the wait
  // ran out) is said as `captcha` — magpie's word for "claim it in the
  // app" — with the plans named: nothing is posted for them, and the
  // account keeps its sign-in.
  let captcha
  try {
    captcha = captchaOf(await clientConfigs())
  } catch (e) {
    rateWait.delete(holdKey(s))
    return { outcome: "failed", message: [...plans.map((p) => `${p.name}: not claimed, ZCode's security check for claims can't be read`), `ZCode's client config: ${e?.message ?? String(e)}`, ...unread].join("; ") }
  }
  if (captcha === null) {
    rateWait.delete(holdKey(s))
    return { outcome: "failed", message: [...plans.map((p) => `${p.name}: not claimed, ZCode's security check for claims can't be read`), ...unread].join("; ") }
  }
  if (captcha.enabled && !captcha.sceneId) {
    rateWait.delete(holdKey(s))
    return { outcome: "captcha", message: plans.map((p) => `${p.name}: ${CAPTCHA_CLAIM}`).join("; ") }
  }
  const got = []
  for (const p of plans) {
    let proof = null
    if (captcha.enabled) {
      try {
        proof = await captchaSolver({ sceneId: captcha.sceneId, region: captcha.region, prefix: captcha.prefix, timeoutMs: CAPTCHA_TIMEOUT_MS })
      } catch (e) {
        // the check wants a person, or this machine can't run it: the
        // plan stays unclaimed, and the rest are not posted either (a
        // claim without the proof is a 3007 the account pays for). The
        // why is the failure alone — `said` adds the one right action.
        got.push({ name: p.name, outcome: "captcha", why: e?.message ?? String(e) })
        break
      }
    }
    const one = { name: p.name, ...(await claimOne(s, p.plan_id, proof)) }
    got.push(one)
    // the campaign's receipt, for a plan that was claimed or had been —
    // never for one that failed (confirmPlan)
    if (one.outcome === "claimed" || one.outcome === "done") await confirmPlan(s, p)
    // 3012 is the account's, not one plan's: posting the plans after it
    // is what raises the cooldown from 30 minutes to 24 hours or a block
    // (see UNUSUAL_ACTIVITY), so the rest are skipped, not failed
    if (one.blocked) break
  }
  const named = (o) => got.filter((g) => g.outcome === o).map((g) => g.name)
  const claimed = named("claimed")
  const said = [
    claimed.length ? `claimed ${claimed.join(", ")}` : "",
    ...got.filter((g) => g.outcome === "captcha").map((g) => `${g.name}: claim it in the ZCode app (${g.why})`),
    ...got.filter((g) => g.outcome === "ineligible").map((g) => `${g.name}: ${g.why}`),
    ...got.filter((g) => g.outcome === "failed").map((g) => `${g.name}: ${g.why}`),
    ...unread,
  ].filter(Boolean).join("; ")
  // a plan claimed now is used by the next request, not ten minutes on
  if (claimed.length) routes.delete(s.key + "\0" + s.jwt)
  // risk control blocked the account: no `until` on purpose (magpie asks a
  // failed again by itself, and asking again is what raises the cooldown)
  if (got.some((g) => g.blocked)) return { outcome: "failed", message: said }
  // a claim ZCode rate limited: the plan may still be there, later
  const limitedClaim = got.find((g) => g.rate !== undefined)
  if (limitedClaim) return { outcome: "failed", message: said, until: noteRateLimit(holdKey(s), limitedClaim.rate, said) }
  rateWait.delete(holdKey(s)) // nothing in this check-in was rate limited: the wait is over
  // a claim that didn't read may be a plan still there: asked again (a
  // list that didn't read is no failure here — the plans it did name were
  // claimed, and the unread one is named in `said`)
  if (got.some((g) => g.outcome === "failed")) return { outcome: "failed", message: said }
  if (got.some((g) => g.outcome === "captcha")) return { outcome: "captcha", message: said }
  if (claimed.length) return { outcome: "claimed", message: said }
  // a plan not offered now can be offered later in the day (11-04: an
  // account's GLOBAL BUILD banner showed 28 minutes after it signed in),
  // so an ineligible is read again half an hour out, as an inactive is —
  // unless ZCode said when the quota resets (1005's data.plan.ends_at),
  // which is the earliest ask worth making
  const ineligible = got.find((g) => g.outcome === "ineligible")
  if (ineligible) return { outcome: "ineligible", message: said, until: ineligible.until ?? recheck() }
  return { outcome: "done", message: `already claimed: ${named("done").join(", ")}` }
}

export {
  CLAIMED_ALREADY, CAPTCHA, NOT_ELIGIBLE, QUOTA_EXHAUSTED, RATE_LIMITED, RATE_LIMIT_MAX_MS,
  UNUSUAL_ACTIVITY, UNUSUAL_ACTIVITY_CLAIM,
  rateWait, resetRateWait, holdKey, noteRateLimit, CAPTCHA_WORDS, claimNeedsCaptcha,
  CAPTCHA_CLAIM, CAPTCHA_TIMEOUT_MS, setCaptchaSolver, marketingHeaders, claimOne, TOUCH, PREVIEW, MARKETING_ACTION,
  EVENT_REPORT, ACTIVATION_EVENTS, CLAIM_ACTION, touchSeq, deviceOf, endsAt,
  clientLanguage, clientTimezone, osCategory, touchPlans, previewPlans, toClaim, reportActivation, confirmPlan,
  RECHECK_MS, recheck, NO_PLAN_TODAY, claimDaily,
  CLAIM_HINT, claimHint,
}
