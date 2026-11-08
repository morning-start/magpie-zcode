// src/gift.mjs —— ZCode 赠送额度（Start Plan / 1024 Dev Day 等）的读取与归属
//
// 赠送额度是 zcode.z.ai 用 ZCode 自己的会话 token 服务的：余额里有几个并行的
// 计划，每个计划下若干 bucket，bucket 按模型名（小写）声明它服务哪些模型。
// 这里只做「读出余额 → 哪些模型还能花 → 卡片上的窗口长什么样」，
// 不决定请求去哪（见 plan.mjs）。

import { MODELS, first, num, compact, startNum, periodOf, jwtExpired, EXPIRED, ZCODE, APP_VERSION } from "./zcode.mjs"
import { call } from "./zai-call.mjs"

// the alias is the catalog spelling of the model plus -trial, so the picker
// reads GLM-5.3-Trial while the loader strips it back to the raw name
const giftID = (m) => (MODELS.find((x) => x.id.toLowerCase() === String(m).toLowerCase())?.id ?? m) + "-Trial"
const uniqueModels = (names) => {
  const byName = new Map()
  for (const m of names) if (!byName.has(m.toLowerCase())) byName.set(m.toLowerCase(), m)
  return [...byName.values()]
}
const giftNames = (g) => g?.allModels ?? g?.models ?? []
// wireModel is a gift model as ZCode sends it: the buckets name it lowercased
// ("glm-5.3-flash"), the app's request carries its registry id
// ("GLM-5.3-Flash"; normalizeOfficialGlmModelId's spelling). Names ZCode
// does not know go as the bucket wrote them.
const wireModel = (m) => MODELS.find((x) => x.id.toLowerCase() === String(m).toLowerCase())?.id ?? m
const giftModel = (g, id) => giftNames(g).find((m) => giftID(m).toLowerCase() === id.toLowerCase())
const bucketModels = (x) => (Array.isArray(x.capabilities) ? x.capabilities : [])
  .map((c) => String(c ?? "").trim()).filter((c) => c.startsWith("model:") || !c.includes(":"))
  .map((c) => c.replace(/^model:/, "").trim()).filter(Boolean)

// Both the card and the request route use the same test for a spent bucket.
// Older balances may omit remaining_units but still tell used and total.
const giftSpent = (x) => {
  const left = num(x.remaining_units)
  if (left !== undefined) return left <= 0
  const total = num(x.total_units), used = num(x.used_units)
  return total !== undefined && used !== undefined && used >= total
}

// startPlan is the gift an account can spend now ({models}), as ZCode reads
// its balance: several plans can be active at once, and a model routes to
// the gift when any of them has a live bucket serving it — a bucket past
// its plan's own end, or one whose remaining_units says none, is skipped
// rather than asked and refused. models are those live buckets' names.
//
// coming (sign-in only) also takes a plan that has not started yet, as
// ZCode's own check does (resolveStartPlanBalanceAvailability's "pending"
// counts as entitled): {name, models: [], coming: true}. Requests and the
// card never ask for it: a plan not started serves nothing yet.
async function startPlan(jwt, device, coming = false) {
  if (!jwt) throw new Error("not signed in to ZCode")
  if (jwtExpired(jwt)) throw new Error(EXPIRED)
  const b = (await call("GET", `${ZCODE}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, { auth: "Bearer " + jwt, device })) ?? {}
  const now = num(b.server_time) > 0 ? num(b.server_time) : Date.now() / 1000
  const same = (x, p) => (x.user_plan_id && p.user_plan_id ? x.user_plan_id === p.user_plan_id : String(x.plan_id ?? "") === String(p.plan_id ?? ""))
  const plans = Array.isArray(b.plans) ? b.plans : []
  const balances = Array.isArray(b.balances) ? b.balances : []
  const ms = new Set(), all = new Map()
  let ttl = 600_000
  let any = false
  let name = ""
  for (const p of plans) {
    const st = String(p?.status ?? "").trim().toLowerCase()
    const end = num(p?.ends_at)
    if (st !== "active" || (end > 0 && end <= now) || notStarted(p, now)) continue
    any = true
    if (end > 0) ttl = Math.min(ttl, (end - now) * 1000)
    if (!name) name = String(p?.name ?? "").trim()
    for (const x of balances) {
      if (!same(x, p)) continue
      const exp = num(x.expires_at)
      if (exp > 0 && exp <= now) continue
      if (exp > 0) ttl = Math.min(ttl, (exp - now) * 1000)
      // Spent buckets still declare models; only live ones can spend now.
      for (const m of bucketModels(x)) {
        if (!all.has(m.toLowerCase())) all.set(m.toLowerCase(), m)
        if (!giftSpent(x)) ms.add(m)
      }
    }
  }
  if (any) return { name: name || "Start Plan", models: [...ms], allModels: [...all.values()], ttl }
  if (!coming) return null
  const next = plans.filter((p) => notStarted(p, now) && !(num(p?.ends_at) > 0 && num(p?.ends_at) <= now))
    .sort((a, b) => startNum(a.starts_at) - startNum(b.starts_at))[0]
  return next ? { name: String(next.name ?? "").trim() || "Start Plan", models: [], allModels: [], ttl, coming: true } : null
}
// blocked remembers the models a gift said it has none left for: a key+jwt+
// model for a minute, so one turn that is refused does not ask again.
const blocked = new Map()
// sidelined remembers, the same way, the models whose gift turned free
// first away for another reason (a 405/3012, a block page): free first
// leaves them on the plan for the minute, but a -Trial entry, the user's
// own pick of the gift, still asks ZCode and gets its real answer. Once
// one rest served both, and a refusal under free first answered the
// Trial entry locally as a quota "exhausted" it never was (Can4ry_ on X).
const sidelined = new Map()
const rest = (map, k) => {
  for (const [x, until] of map) if (Date.now() >= until) map.delete(x)
  map.set(k, Date.now() + 60_000)
}

// giftServes: the gift's buckets name their models lowercased ("glm-5.3-
// flash"); what is asked for arrives as the plan lists it ("GLM-5.3-Flash").
const giftServes = (gift, m) => (gift.models ?? []).some((x) => x.toLowerCase() === m.toLowerCase())
const giftRested = (s, m) => Date.now() < (blocked.get(s.key + "\0" + s.jwt + "\0" + m.toLowerCase()) ?? 0)
const giftUsable = (s, gift, m) => !jwtExpired(s.jwt) && giftServes(gift, m) &&
  Date.now() >= (blocked.get(s.key + "\0" + s.jwt + "\0" + m.toLowerCase()) ?? 0)
const giftSidelined = (s, m) => Date.now() < (sidelined.get(s.key + "\0" + s.jwt + "\0" + m.toLowerCase()) ?? 0)
// notStarted is a plan whose starts_at is still to come (a Start Plan
// that takes effect at 23:00 today, windy on Discord): it serves nothing
// yet, so no request is routed to it and its buckets don't count, but the
// card names it with its start. ZCode's balance gives every plan a
// starts_at in Unix seconds; which status a plan not started yet carries
// is not known, so any but "expired" is taken.
function notStarted(p, now) {
  const at = startNum(p?.starts_at)
  return at > now && String(p?.status ?? "").trim().toLowerCase() !== "expired"
}

// PENDING is the card's line for a gift plan that has not started yet: a
// fixed sentence, so magpie translates it; the plan's name and its start,
// in this computer's time, are the display. Set aside: it stops nothing.
const PENDING = "ZCode gift plan not started yet"
const two = (n) => String(n).padStart(2, "0")
const localTime = (sec) => {
  const d = new Date(Math.trunc(sec) * 1000)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
const pendingLines = (g) => (g?.pending ?? []).map((p) => ({ name: PENDING, used: 0, aside: true, display: `${p.name} · ${localTime(p.start)}` }))
// giftOf reads the balance and returns the gift's card fields: its plans and
// windows. Several plans can be active at once, so every live plan's buckets
// show, each keeping its own models and end; the plan and end put on the
// card (for a gift-only account) are the soonest-ending live plan's. null
// when there is no live plan to show.
async function giftOf(s) {
  if (!s.jwt) throw new Error("not signed in to ZCode")
  if (jwtExpired(s.jwt)) throw new Error(EXPIRED)
  const b = (await call("GET", `${ZCODE}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, { auth: "Bearer " + s.jwt, device: s.device })) ?? {}
  const str = (v) => (typeof v === "string" ? v : "")
  const plans = (Array.isArray(b.plans) ? b.plans : []).map((p) => ({ ...p, status: str(p?.status), user_plan_id: str(p?.user_plan_id), plan_id: str(p?.plan_id) }))
  const now = startNum(b.server_time) > 0 ? startNum(b.server_time) : Math.trunc(Date.now() / 1000)
  const over = new Set()
  for (const p of plans) {
    const end = startNum(p.ends_at)
    if (end > 0 && end <= now && p.status.trim().toLowerCase() === "active") p.status = "expired"
    if (p.status.trim().toLowerCase() === "expired") over.add(p.user_plan_id + "\0" + p.plan_id)
  }
  const same = (x, p) => (x.user_plan_id && p.user_plan_id ? x.user_plan_id === p.user_plan_id : String(x.plan_id ?? "") === String(p.plan_id ?? ""))
  const balances = (Array.isArray(b.balances) ? b.balances : [])
    .map((x) => ({ ...x, user_plan_id: str(x?.user_plan_id), plan_id: str(x?.plan_id) }))
    .filter((x) => {
      let keep = true
      for (const p of plans) {
        if (!same(x, p)) continue
        keep = !over.has(p.user_plan_id + "\0" + p.plan_id)
        if (keep) break
      }
      return keep
    })

  // a plan not started yet is named with its start, soonest first; its
  // buckets, if the balance lists any, wait for it
  const pending = plans.filter((p) => notStarted(p, now))
    .map((p) => ({ name: first(str(p.name), "Start Plan"), start: startNum(p.starts_at) }))
    .sort((a, b) => a.start - b.start)

  // every live plan counts as the gift: no plan-name filter decides it,
  // the balance says what the session can spend
  let active = null
  for (const p of plans) {
    if (p.status.trim().toLowerCase() !== "active" || notStarted(p, now)) continue
    const end = startNum(p.ends_at)
    if (end > 0 && end <= now) continue
    if (active && !(end > 0 && (!startNum(active.end) || end < startNum(active.end)))) continue
    active = { name: first(str(p.name), "Start Plan"), end, until: end > 0 ? new Date(Math.trunc(end) * 1000).toISOString() : "" }
  }
  if (!active && !pending.length) return null
  // with no live plan, the one starting soonest names the card
  const out = { plan: active?.name ?? pending[0].name, windows: [], live: !!active, pending }
  if (active?.until) Object.assign(out, { until: active.until, renew: "off" })
  const live = plans.filter((p) => {
    if (p.status.trim().toLowerCase() !== "active" || notStarted(p, now)) return false
    const end = startNum(p.ends_at)
    return !(end > 0 && end <= now)
  })
  for (const x of balances) {
    const owner = live.find((p) => same(x, p))
    if (!owner) continue
    const exp = startNum(x.expires_at)
    if (exp > 0 && exp <= now) continue // a bucket past its own end is over
    const total = startNum(x.total_units), left = startNum(x.remaining_units)
    let used = startNum(x.used_units)
    if (total === undefined && used === undefined && left === undefined) continue
    const models = bucketModels(x)
    const base = first(str(x.show_name), models.join(", "), "Credits")
    const w = { name: base, used: 0, _plan: str(owner.name), _spent: giftSpent(x) }
    if (used === undefined) used = total !== undefined && left !== undefined ? total - left : 0
    if (total > 0) {
      // the bucket's count as amount of limit, as the Coding windows' is
      // (#659): magpie says it as used or as left, as it says the share
      w.used = (100 * used) / total
      w.amount = used
      w.limit = total
      w.display = `${compact(used)} / ${compact(total)}`
    }
    if (w._spent) w.used = Math.max(100, w.used)
    if (exp > 0) w.resetsAt = new Date(Math.trunc(exp) * 1000).toISOString()
    let span = 0
    for (const p of plans) {
      if (!same(x, p)) continue
      for (const e of Array.isArray(p.entitlements) ? p.entitlements : []) {
        if (str(e?.entitlement_id) === str(x.entitlement_id)) span = periodOf(str(e?.period))
      }
    }
    if (!span) {
      const a = startNum(x.period_start), z = startNum(x.period_end)
      if (a !== undefined && z !== undefined && z > a) span = Math.trunc(z - a)
    }
    if (span) w.span = span
    if (models.length) w.models = models
    out.windows.push(w)
  }
  return out
}
// GIFT_SIGN_IN is the card's line for an account whose gift plans can't
// be read: ZCode's gift plans (the Start Plan, ZCode 1024 Dev Day, ZCode
// Trust Build) are served by zcode.z.ai to ZCode's own session alone, so
// a GLM Coding Plan key, or a sign-in whose ZCode session has run out
// (that token can't be renewed), lists no <model>-Trial entries and
// spends the coding plan alone. A fixed sentence, so magpie can
// translate it; why goes in the display. Set aside: it stops nothing.
const GIFT_SIGN_IN = "ZCode gift plans (-Trial models) need ZCode's sign-in"
function giftSignIn(s, key) {
  if (!s.jwt) return { name: GIFT_SIGN_IN, used: 0, aside: true, display: key ? "not read with an API key: add the account with a ZCode sign-in" : "this sign-in has no ZCode session: sign in again" }
  if (jwtExpired(s.jwt)) return { name: GIFT_SIGN_IN, used: 0, aside: true, display: "ZCode's sign-in has expired: sign in again" }
  return null
}
// giftReadable: ZCode's session can read the gift beside a coding plan,
// so the card asks for it even when no gift is live for requests: a plan
// that starts later is named on the card (windy, Discord), not left out
// because nothing could be spent yet.
const giftReadable = (s) => !!s.jwt && !jwtExpired(s.jwt)

export {
  giftID, uniqueModels, giftNames, wireModel, giftModel, bucketModels, giftSpent,
  startPlan, blocked, sidelined, rest, giftServes, giftRested, giftUsable, giftSidelined,
  notStarted, PENDING, two, localTime, pendingLines, giftOf,
  GIFT_SIGN_IN, giftSignIn, giftReadable,
}
