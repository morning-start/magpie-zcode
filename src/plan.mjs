// src/plan.mjs —— 一个账号的请求该去哪：Coding Plan、团队席位，还是 Start Plan
//
// ZCode 的账号可能是「有 GLM Coding Plan」「只有团队席位」「两者都没有、
// 只剩赠送额度」。plansOf 把这件事读一次并缓存十分钟（读失败一分钟），
// 拒绝过的模型记在 blocked/sidelined 里，避免同一轮反复撞墙。

import { rootOf, isTeam, first, jwtExpired } from "./zcode.mjs"
import { call } from "./zai-call.mjs"
import { startPlan } from "./gift.mjs"

// plan names the coding plan a key has, "" for none.
async function plan(s) {
  const subs = (await call("GET", rootOf(s.base) + "/api/biz/subscription/list", { auth: s.key })) ?? []
  return (Array.isArray(subs) ? subs : []).find((x) => String(x.status).toUpperCase() === "VALID")?.productName ?? ""
}
const routes = new Map()
async function plansOf(s) {
  if (!s.jwt) return { start: false, gift: null }
  if (!s.key && !isTeam(s)) return { start: true, gift: null }
  const id = s.key + "\0" + s.jwt
  const r = routes.get(id)
  if (r && Date.now() - r.at < r.ttl) return r
  let start = false
  let gift = null
  let sure = false
  try {
    // A team seat stays on its team even when its personal plan list is
    // empty. Its ZCode session still holds the person's gift plans.
    if (!isTeam(s) && !(await plan(s))) start = true
    else {
      // a gift read that failed is unknown, not "no gift": asked again in
      // a minute, so its trial entries come back with the next list (an
      // expired session is known: the card says to sign in again)
      let failed = false
      gift = await startPlan(s.jwt, s.device).catch(() => ((failed = !jwtExpired(s.jwt)), null))
      sure = !failed
    }
    // a key whose plan list read no plan, where the last read found one,
    // is asked again in a minute rather than sent to the Start Plan for
    // ten: one list without the plan (a renewal's boundary, a hiccup)
    // turned a GLM Coding Plan account's every request into the Start
    // Plan's 405 until the route was read again (#369)
    if (start) sure = !(s.key && r && !r.start)
  } catch {
    // the plan list could not be read: a key account takes the dual route
    // (start stays false, the gift is kept, a minute's ttl), so a gift
    // refusal still replays to the coding plan rather than blacking out
    try {
      gift = await startPlan(s.jwt, s.device)
      sure = false
    } catch {}
  }
  const out = { start, gift, at: Date.now(), ttl: Math.min(sure ? 600_000 : 60_000, gift?.ttl ?? 600_000) }
  routes.set(id, out)
  return out
}
const NO_PLAN_KEY =
  "this key's account has no GLM Coding Plan; ZCode's gift plans (the Start Plan, ZCode 1024 Dev Day) are spent only with ZCode's sign-in, never with a key — add the account with \"ZCode app's sign-in\" or a ZCode sign-in in the browser"

// noPlanKey is a coding plan's 1113 refusal (no plan, no resource
// package) to a sign-in with no ZCode session, its message followed by
// NO_PLAN_KEY; anything else goes on as it came. Read only once the
// answer has failed.
function noPlanKey(res, text) {
  let v
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  // Z.ai names the code in error.code ("1113", as magpie's
  // zhipu_coding_test has it) or error.type (its 401's "1000"), BigModel's
  // envelope in code
  if (![v?.error?.code, v?.error?.type, v?.code].some((c) => String(c ?? "") === "1113")) return null
  const said = first(v?.error?.message, v?.msg, v?.message)
  const out = v?.error && typeof v.error === "object" ? { ...v, error: { ...v.error, message: (said ? said + " — " : "") + NO_PLAN_KEY } } : { ...v, msg: (said ? said + " — " : "") + NO_PLAN_KEY }
  const h = new Headers(res.headers)
  h.set("content-type", "application/json")
  return new Response(JSON.stringify(out), { status: res.status, statusText: res.statusText, headers: h })
}

export { plan, routes, plansOf, NO_PLAN_KEY, noPlanKey }
