// src/allowance.mjs —— 额度卡片：Coding Plan 的窗口与套餐、团队席位、赠送额度
//
// 这里产出的窗口直接喂给 magpie 的进度条和智能路由：used 是路由排序输入，
// aside 的窗口只上卡片。时间一律转成 ISO（见 HOOKS 三 · 规矩 ②）。

import { rootOf, BIGMODEL_API, BIGMODEL_BASE, compact, first, isNum, startNum } from "./zcode.mjs"
import { call } from "./zai-call.mjs"
import { giftOf, giftID, uniqueModels, pendingLines } from "./gift.mjs"
import { routes, NO_PLAN_KEY } from "./plan.mjs"
import { teamHeaders } from "./keys.mjs"

// ---- allowance ---------------------------------------------------------------------
// As magpie's built-in told it (internal/provider zcode.go, zcode_start.go,
// zcode_team.go): the Coding Plan's windows and term, the Start Plan's
// buckets, or a team seat's windows and its plan's end.

// bizRoot is the business API of the site a plan is served from.
function bizRoot(base) {
  let h = ""
  try {
    h = new URL(base).host.toLowerCase()
  } catch {}
  return h === new URL(BIGMODEL_BASE).host || h.endsWith("bigmodel.cn") ? BIGMODEL_API : rootOf(base)
}

// spanOf reads a limit's window, in seconds: unit 3 counts hours, 6 weeks
// (and 1, 4, 5 minutes, days and months by the same count). A team's five
// hours come with no count.
function spanOf(unit, n) {
  n = Math.trunc(Number(n) || 0)
  if (unit === 3 && n <= 0) n = 5
  n = Math.max(n, 1)
  return { 1: 60, 3: 3600, 4: 86400, 5: 30 * 86400, 6: 7 * 86400 }[unit] * n || 0
}

function windowName(span) {
  if (span === 0) return "Credits"
  if (span < 86400) return `${Math.trunc(span / 3600)} hours`
  if (span === 7 * 86400) return "Weekly"
  if (span >= 28 * 86400) return "Monthly"
  return `${Math.trunc(span / 86400)} days`
}

// compact is a count as magpie says one: whole, else to two places.
// limitWindows are /api/monitor/usage/quota/limit's limits as windows: what
// is used of the whole when both are told (the whole less what remains, or
// the current value), else the percentage given. TIME_LIMIT is the month's
// MCP tool calls, which ZCode shows but never stops the models on, so it is
// set aside, as is a limit whose whole is told as 0: no cap (an older
// plan's), which the vendor may still give as 100% used. A window whose
// count is told carries it as amount of limit, so magpie's card says the
// count as used or as left, as it says the share beside it (#659).
function limitWindows(d) {
  const out = []
  for (const x of d?.limits ?? []) {
    const span = spanOf(Math.trunc(Number(x?.unit) || 0), x?.number)
    const w = { name: windowName(span), used: 0 }
    if (String(x?.type ?? "").toUpperCase() === "TIME_LIMIT") (w.name = "MCP · Month"), (w.aside = true)
    if (isNum(x?.percentage)) w.used = x.percentage
    if (x?.usage === 0) (w.used = 0), (w.aside = true)
    if (isNum(x?.usage) && x.usage > 0) {
      const total = x.usage
      if (isNum(x.remaining)) {
        const used = total - x.remaining
        w.used = (100 * used) / total
        w.amount = used
        w.limit = total
        w.display = `${compact(used)} / ${compact(total)}`
      } else if (isNum(x.currentValue)) {
        if (!isNum(x.percentage)) w.used = (100 * x.currentValue) / total
        w.amount = x.currentValue
        w.limit = total
        w.display = `${compact(x.currentValue)} / ${compact(total)}`
      }
    }
    const reset = Math.trunc(Number(x?.nextResetTime) || 0)
    if (reset > 0) w.resetsAt = new Date(reset).toISOString()
    if (span) w.span = span
    out.push(w)
  }
  return out
}

// beijing reads the plan's times, "2026-10-18 12:00:00" in Beijing: ms, or 0.
function beijing(s) {
  s = String(s ?? "").trim().replace(" ", "T")
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/.test(s)) return 0
  const t = Date.parse(s + (s.length === 10 ? "T00:00:00" : "") + "+08:00")
  return Number.isFinite(t) ? t : 0
}

// termOf is how long a GLM Coding plan is paid for: the valid
// subscription's next renewal, a charge when it renews itself, else the
// end of its time, the last date its "valid" span names.
function termOf(subs) {
  for (const x of Array.isArray(subs) ? subs : []) {
    if (String(x?.status ?? "").toUpperCase() !== "VALID") continue
    const auto = x.autoRenew === true || x.autoRenew === 1
    const t = beijing(typeof x.nextRenewTime === "string" ? x.nextRenewTime : "")
    if (t) return { until: new Date(t).toISOString(), renew: auto ? "auto" : "off" }
    const ds = String(typeof x.valid === "string" ? x.valid : "").match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/g) ?? []
    if (ds.length && !auto) {
      const end = beijing(ds[ds.length - 1])
      if (end) return { until: new Date(end).toISOString(), renew: "off" }
    }
    return {}
  }
  return {}
}

// codingUsage is a Coding Plan key's allowance: credits per five hours and
// per week, the plan's level and its term.
async function codingUsage(s) {
  const root = rootOf(s.base)
  const d = (await call("GET", root + "/api/monitor/usage/quota/limit", { auth: s.key })) ?? {}
  const out = {}
  const level = typeof d.level === "string" ? d.level : ""
  if (level) out.plan = "GLM Coding " + level[0].toUpperCase() + level.slice(1)
  out.windows = limitWindows(d)
  const resets = personalResets(root, s.key)
  let subs = null
  try {
    subs = await call("GET", root + "/api/biz/subscription/list", { auth: s.key })
    Object.assign(out, termOf(subs))
  } catch {}
  const r = await resets
  if (r) out.resets = r
  // a key whose account has no plan in force, read as such, says so
  // rather than showing an empty card: what a key can spend is a GLM
  // Coding Plan alone (a ZCode gift plan is never one, see NO_PLAN_KEY).
  // A list that couldn't be read, a level, a counted window or a plan
  // the sign-in saved keeps the card as it was.
  const valid = (Array.isArray(subs) ? subs : []).some((x) => String(x?.status ?? "").toUpperCase() === "VALID")
  if (subs !== null && !valid && !level && !s.plan && !out.windows.some((w) => !w.aside)) return { error: NO_PLAN_KEY }
  return out
}
// startUsage is a gift-only account's card: its buckets, or the words
// for having none to show. The card's header already names the plan, so
// the windows of one plan keep their own names; with several plans each
// bucket is named after its plan (see byPlan).
const NO_START = "this account has no GLM Coding Plan, and ZCode's Start Plan has ended or was never started"
async function startUsage(s) {
  const g = await giftOf(s)
  if (!g) return { error: NO_START }
  const best = bestBuckets(g.windows)
  const label = byPlan(g.windows)
  g.windows = countedFirst(g.windows.map(({ _plan, _spent, ...w }, i) => {
    w.name = label(w.name, _plan)
    if (!w.models?.length) return w
    // a model two plans give (Trust Build's and the Start Plan's Flash)
    // counts on the bucket ZCode spends now; the other stays on the card
    // without holding the model up (ganlerk, Discord)
    const models = w.models.filter((m) => best.get(m.toLowerCase()) === i)
    if (!models.length) {
      delete w.models
      return { ...w, aside: true }
    }
    return { ...w, models: [...models, ...models.map(giftID)] }
  }))
  g.windows.push(...pendingLines(g))
  delete g.live
  delete g.pending
  return g
}

// byPlan names a bucket after its plan ("GLM-5.3 · ZCode 1024 Dev Day")
// when the gift's buckets come from more than one plan: two plans each
// give a GLM-5.3, and named alike a spent one and a live one can't be
// told apart (01huadalang, Discord: the new-user plan's spent GLM-5.3
// showed, the 1024 plan's own GLM-5.3 didn't). One plan's buckets keep
// their own names, as the card's header names the plan.
function byPlan(windows) {
  const several = new Set(windows.map((w) => w._plan || "")).size > 1
  return (name, plan) => (several && plan ? name + " · " + plan : name)
}

// countedFirst puts the buckets a request spends before those set aside
// (a spent bucket another plan's live one stands in for), each group in
// the balance's order: magpie's account row shows a card's first two
// windows and leaves the rest to its tooltip, so a spent plan listed first
// hid the live plan's allowance for the same model.
const countedFirst = (ws) => [...ws.filter((w) => !w.aside), ...ws.filter((w) => w.aside)]

// bestBuckets is, for each model the gift's buckets serve, the index of
// the one a request spends: a live one before a spent one, the least
// used of those. The server picks among an account's buckets itself
// (ZCode sends no plan with a request), so one spent bucket doesn't stop
// a model another still has.
function bestBuckets(windows) {
  const best = new Map()
  windows.forEach((w, i) => {
    for (const m of w.models ?? []) {
      const key = m.toLowerCase(), old = best.get(key), prev = windows[old]
      if (old === undefined || (prev._spent && !w._spent) || (prev._spent === w._spent && w.used < prev.used)) best.set(key, i)
    }
  })
  return best
}
// dualUsage shows both pools but only the pool a request can use counts
// for its model. Live gift models don't spend the Coding windows; spent
// or blocked gift buckets stay visible without holding up the Coding Plan.
// Fresh usage also updates the request cache, so a replenished or spent
// gift takes effect before its ten-minute route cache expires. A failed
// gift read leaves the working Coding Plan's card and route alone.
async function dualUsage(s, out) {
  out ??= await codingUsage(s)
  const cached = routes.get(s.key + "\0" + s.jwt)
  try {
    const g = await giftOf(s)
    const gift = g?.live ? { name: g.plan, models: [...new Set(g.windows.filter((w) => !w._spent)
      .flatMap((w) => w.models ?? []).map((m) => m.toLowerCase()))],
      allModels: uniqueModels(g.windows.flatMap((w) => w.models ?? [])) } : null
    if (cached) {
      cached.gift = gift
      // a plan that starts later is read again when it starts
      const ends = g ? [g.until, ...g.windows.map((w) => w.resetsAt)].map((t) => Date.parse(t))
        .concat(g.pending.map((p) => p.start * 1000)).filter(Number.isFinite) : []
      if (ends.length) cached.ttl = Math.min(cached.ttl, Math.max(0, Math.min(...ends) - cached.at))
    }
    if (g?.live) {
      // the gift's models are its trial entries alone: a plain model stays
      // on the coding plan, and the user picks the gift by its entry
      const notModels = gift.allModels.map((m) => giftID(m).toLowerCase())
      if (notModels.length) out.windows = out.windows.map((w) => w.aside ? w : { ...w, notModels })
      // Several buckets may serve one model: one spent sibling cannot block it.
      const best = bestBuckets(g.windows)
      // beside the Coding Plan's windows every gift bucket is named after
      // its plan, one plan or several: "GLM-5.1-Trial · Start Plan" can't
      // be read as the Coding Plan's own (windy, Discord). The bucket's
      // own name (ZCode's show_name, as its "Today's balance" lists it)
      // comes first: magpie's ring and account row cut a long name short,
      // and "ZCODE GLOBAL BUI…" said neither the model nor the plan's
      // kind, so the Start Plan read as missing (Danbuth, plugins#504)
      const label = (name, plan) => name + " · " + first(plan, "Start Plan")
      out.windows.push(...countedFirst(g.windows.map(({ _plan: p, _spent, ...w }, i) => {
        const selected = gift.allModels.filter((m) => best.get(m.toLowerCase()) === i)
        const models = selected.map(giftID)
        const scoped = models.length ? { ...w, models } : { ...w, aside: true }
        // the card names a bucket's model as the picker does (GLM-5.3-Flash-Trial)
        let name = w.name
        for (const m of selected) {
          const at = name.toLowerCase().indexOf(m.toLowerCase())
          if (at >= 0) name = name.slice(0, at) + giftID(m) + name.slice(at + m.length)
        }
        return { ...scoped, name: label(name, p) }
      })))
    }
    if (g) out.windows.push(...pendingLines(g))
  } catch {
    if (cached) {
      cached.gift = null
      cached.at = Date.now()
      cached.ttl = 60_000 // an uncertain gift is read again sooner
    }
  }
  return out
}
// when is a team plan's end: a time in Beijing, or a Unix time in seconds
// or milliseconds; ms, or 0.
function when(v) {
  if (typeof v === "string") {
    const t = beijing(v)
    if (t) return t
  }
  const n = startNum(v)
  if (n > 0) return n > 1e12 ? Math.trunc(n) : Math.trunc(n) * 1000
  return 0
}
// teamUsage is a team seat's allowance: the team plan's five hours and
// week, and the plan's name and end.
async function teamUsage(s, key) {
  const root = bizRoot(s.base)
  const headers = teamHeaders(s.base, s.org, s.project)
  const d = (await call("GET", root + "/api/monitor/usage/quota/limit?type=2", { auth: key, headers })) ?? {}
  const out = { windows: limitWindows(d) }
  if (!s.token) return out
  const resets = teamResets(root, s.token, headers)
  try {
    const t = (await call("GET", root + "/api/biz/team/subscribe/product/querySubscribeDetail", { auth: s.token, headers })) ?? {}
    const usable = (t.hasSubscription == null || t.hasSubscription === true) && String(t.status ?? "").toUpperCase() === "EFFECTIVE" &&
      String(t.memberGrantStatus ?? "").toUpperCase() === "VALID"
    if (usable) {
      if (typeof t.productName === "string" && t.productName) out.plan = t.productName
      const end = when(t.subscribeEndTime)
      if (end) Object.assign(out, { until: new Date(end).toISOString(), renew: "off" })
    }
  } catch {}
  const r = await resets
  if (r) out.resets = r
  return out
}

// teamResets is how many resets a team member may spend, of the five hours
// and of the week, marked a team's (team: true), as the built-in's
// zhipuTeamResets did. null when it can't be told or there are none.
async function teamResets(root, auth, headers) {
  const r = await resetsOf(root + "/api/biz/customer-package-reset/list?targetType=TEAM", auth, headers)
  if (r) r.team = true
  return r
}

// personalResets is how many resets a GLM Coding Plan of a person's own
// holds, as bigmodel.cn's usage page lists them, asked with the plan's
// key (the built-in's zhipuPersonalResets). Only read: a reset is spent
// on the vendor's own page, never from here.
async function personalResets(root, key) {
  return resetsOf(root + "/api/biz/customer-package-reset/list?targetType=PERSONAL", key)
}

// resetsOf reads customer-package-reset/list: the resets of the five
// hours and of the week, of which only those still available count (one
// run out stays listed a week, available false), each with its own end
// (each, soonest first, one with no end last) and the soonest as until.
// null when the list can't be read, so no count is shown rather than 0,
// and when it holds none.
async function resetsOf(url, auth, headers) {
  let d
  try {
    d = (await call("GET", url, { auth, headers })) ?? {}
  } catch {
    return null
  }
  let until = 0
  const each = []
  const count = (rs, window) => {
    let n = 0
    for (const x of Array.isArray(rs) ? rs : []) {
      if (x?.available !== true) continue
      n++
      const t = when(x.expireTime)
      if (t && (!until || t < until)) until = t
      each.push(t ? { until: new Date(t).toISOString(), window } : { window })
    }
    return n
  }
  const fiveHour = count(d.fiveHourResets, "fiveHour")
  const weekly = count(d.weekResets, "weekly")
  if (fiveHour + weekly === 0) return null
  const end = (c) => (c.until ? Date.parse(c.until) : Infinity)
  each.sort((a, b) => (end(a) === end(b) ? 0 : end(a) < end(b) ? -1 : 1))
  const r = { count: fiveHour + weekly, byWindow: true, fiveHour, weekly }
  if (until) r.until = new Date(until).toISOString()
  r.each = each
  return r
}

export {
  bizRoot, spanOf, windowName, limitWindows, beijing, termOf, codingUsage,
  NO_START, startUsage, byPlan, countedFirst, bestBuckets, dualUsage,
  teamUsage, teamResets, personalResets, resetsOf,
}
