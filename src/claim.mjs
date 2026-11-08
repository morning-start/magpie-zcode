// src/claim.mjs —— 每日领取 ZCode 的赠送计划（auth.checkin）
//
// ZCode 在营销 feed（marketing/touch）里投节日/新用户的计划，账号要在 ZCode
// App 里点领取。这里替用户领：feed 里有什么、领没领过（1003）、要不要求
// 安全验证（3007）、是不是限流（3002）。限流的等待记在本进程里，
// 等待期内不再打上游（magpie 的 429 退避与厂商的「频率过高」不是一回事）。

import { ZCODE, APP_VERSION, UA, platform, first, STATUS_TEXT, jwtExpired, EXPIRED, sleep } from "./zcode.mjs"
import { call, retryAfterMs } from "./zai-call.mjs"
import { clientConfigs } from "./catalog.mjs"
import { routes } from "./plan.mjs"

// CLAIM_HINT is the claim line's name: a fixed sentence, so magpie
// translates it with the interface's own language (the plan's name and
// the count are data, and go in the display, which is shown as it came).
const CLAIM_HINT = "Gift plans to claim in the ZCode app"

// claimHint is the card's line for gift plans ZCode is holding for the
// account but has not put on it: the app's banners (marketing/touch)
// list them (toClaim). The
// card only names them: they are claimed in the ZCode app, or by the
// daily claim (claimDaily) when the user turned it on; on 10-06 a claim
// without the app's Aliyun captcha attestation was refused (3007). A window, set aside (it is no
// allowance: using it up stops nothing), so the card shows it and
// routing, caps and the menu bar pass it over. The window's name is a
// fixed sentence, so magpie can translate it (a display is shown as it
// came); the count and the plan's own name go in the display. null when
// there is nothing to claim, the preview failing or listing none among
// it: a failed read is no line at all, never a card or a refusal of its
// own.
async function claimHint(s) {
  if (!s.jwt || jwtExpired(s.jwt)) return null
  const { plans } = await toClaim(s)
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
// NOT_ELIGIBLE is /billing/claim's body code for a plan the account is not
// offered at that moment: HTTP 400 {"code":1004,…}. A stale APP_VERSION
// answers it for every account at once (11-04: six accounts all answered
// 1004 under 3.16.3's header, and four of them claimed with code 0 under
// 3.17.2's, one night, with nothing else changed).
const NOT_ELIGIBLE = 1004
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
const CAPTCHA_CLAIM = "claim it in the ZCode app: ZCode asks its security check before a claim, which only the app passes, so the daily check-in leaves it to the app"

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
async function claimOne(s, planID) {
  let res, text
  try {
    res = await fetch(`${ZCODE}/api/v1/zcode-plan/billing/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA, Authorization: "Bearer " + s.jwt, "X-Device-Mid": s.device || anyDevice, ...marketingHeaders() },
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
  if (code === CLAIMED_ALREADY) return { outcome: "done" }
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
// banner.background.args.zcode_plan.name). The v3.17 client reads this
// feed alone: the old preview polling is gone, and the rewards center's
// gifts are the rewards website's, claimed in the client.
const TOUCH = "/api/v1/marketing/touch"
const CLAIM_ACTION = "claim_zcode_plan"
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

// touchPlans is the plans marketing/touch's deliveries offer to claim:
// [{plan_id, name}], [] for a feed with no deliveries, null for one that
// doesn't read. Each delivery is searched for its claim_zcode_plan
// actions and its zcode_plan's name, wherever the banner keeps them, so
// a button moved inside the banner is still found.
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
    for (const id of ids) out.push({ plan_id: id, name: first(names[0] ?? "", id) })
  }
  return out
}

// toClaim is every gift plan the account can claim: what the app's
// marketing feed offers (its banners). The v3.17 client replaced the old
// preview polling with the feed alone (docs/marketing-touch-client.md in
// zai-org/ZCode), so the preview is read no more; a rewards center's gift
// lives on the rewards website, outside this API, and is claimed in the
// client. unread names a feed that didn't read: its plans are unknown,
// never none.
async function toClaim(s) {
  const plans = [], unread = []
  const add = (p) => {
    if (!plans.some((q) => q.plan_id === p.plan_id)) plans.push(p)
  }
  let d
  try {
    d = await call("GET", `${ZCODE}${TOUCH}?seq=${touchSeq++}`, { auth: "Bearer " + s.jwt, device: s.device, headers: marketingHeaders() })
  } catch (e) {
    unread.push(`gift plans to claim: ${e?.message ?? String(e)}`)
    // rate is the ms ZCode asked to wait (0 when it sent no Retry-After),
    // null when this was not a rate limit at all
    return { plans, unread, rate: e?.status === 429 || e?.code === RATE_LIMITED ? (e.retryAfterMs || 0) : null }
  }
  const got = touchPlans(d)
  if (!got) unread.push("gift plans to claim: the plan list doesn't read")
  else got.forEach(add)
  return { plans, unread, rate: null }
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

// claimDaily claims every gift plan ZCode offers the account (#503:
// toClaim, the app's banners and its preview), as auth.checkin's answer:
// inactive when neither lists one, claimed when one was claimed now,
// done when each was claimed before, captcha when ZCode wants the app's
// captcha for one (it is claimed in the ZCode app), ineligible when
// ZCode is not offering one at that moment (code 1004, read again later
// in the day), failed when a list
// or a claim can't be read. A rate-limited read (HTTP 429, or code 3002)
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
  const { plans, unread, rate = null } = await toClaim(s)
  // a rate-limited read: held here until the wait is over
  if (rate !== null) {
    const message = unread.join("; ") || "ZCode rate limited this account"
    return { outcome: "failed", message, until: noteRateLimit(holdKey(s), rate, message) }
  }
  // the feed answered and no claim is read: the wait is over. It is not
  // forgotten before the claims below, so a claim ZCode keeps limiting
  // waits longer each time (see noteRateLimit)
  if (!plans.length) {
    rateWait.delete(holdKey(s))
    return unread.length
      ? { outcome: "failed", message: unread.join("; ") }
      : { outcome: "inactive", message: "no ZCode gift plan to claim", until: recheck() }
  }
  // a claim ZCode guards with its security check is not posted: the app
  // passes it before each claim and sends the proof in a header, which
  // this plugin can't make, and a claim without it only gets 3007 again
  // (young02036 on Discord, 11-07: asked every day, never claimed). The
  // plans are named, to claim in the ZCode app. A config that doesn't
  // read leaves it unknown: nothing is posted, and it is asked again.
  let guarded
  try {
    guarded = claimNeedsCaptcha(await clientConfigs())
  } catch (e) {
    guarded = null
    unread.push(`ZCode's client config: ${e?.message ?? String(e)}`)
  }
  if (guarded !== false) {
    rateWait.delete(holdKey(s))
    if (guarded === null) return { outcome: "failed", message: [...plans.map((p) => `${p.name}: not claimed, ZCode's security check for claims can't be read`), ...unread].join("; ") }
    return { outcome: "captcha", message: plans.map((p) => `${p.name}: ${CAPTCHA_CLAIM}`).join("; ") }
  }
  const got = []
  for (const p of plans) got.push({ name: p.name, ...(await claimOne(s, p.plan_id)) })
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
  // a claim ZCode rate limited: the plan may still be there, later
  const limitedClaim = got.find((g) => g.rate !== undefined)
  if (limitedClaim) return { outcome: "failed", message: said, until: noteRateLimit(holdKey(s), limitedClaim.rate, said) }
  rateWait.delete(holdKey(s)) // nothing in this check-in was rate limited: the wait is over
  // a list that didn't read may hold a plan not claimed: asked again
  if (unread.length || got.some((g) => g.outcome === "failed")) return { outcome: "failed", message: said }
  if (got.some((g) => g.outcome === "captcha")) return { outcome: "captcha", message: said }
  if (claimed.length) return { outcome: "claimed", message: said }
  // a plan not offered now can be offered later in the day (11-04: an
  // account's GLOBAL BUILD banner showed 28 minutes after it signed in),
  // so an ineligible is read again half an hour out, as an inactive is
  if (got.some((g) => g.outcome === "ineligible")) return { outcome: "ineligible", message: said, until: recheck() }
  return { outcome: "done", message: `already claimed: ${named("done").join(", ")}` }
}

export {
  CLAIMED_ALREADY, CAPTCHA, NOT_ELIGIBLE, RATE_LIMITED, RATE_LIMIT_MAX_MS,
  rateWait, resetRateWait, holdKey, noteRateLimit, CAPTCHA_WORDS, claimNeedsCaptcha,
  CAPTCHA_CLAIM, marketingHeaders, claimOne, TOUCH, CLAIM_ACTION, touchSeq,
  clientLanguage, touchPlans, toClaim, RECHECK_MS, recheck, claimDaily,
  CLAIM_HINT, claimHint,
}
