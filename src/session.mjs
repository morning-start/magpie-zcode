// src/session.mjs —— 把 magpie 存的登录态还原成请求需要的样子
//
// magpie 的 auth 是 {type, access, refresh, ...}；请求要的是 {site, base, key,
// jwt, device, org, project}。ZCode 的 token 是 JSON 塞在 refresh 里的，
// 所以这里要解析、兜底、并给没有 device 的账号算一个稳定的 device id。

import { siteOf, SITES, keyDevice, anyDevice } from "./zcode.mjs"
import { ownSignIn } from "./own.mjs"

// stateOf is a stored sign-in as the requests need it.
function stateOf(auth) {
  if (auth?.type === "oauth") {
    let s = {}
    try {
      s = JSON.parse(auth.refresh)
    } catch {}
    if (s.source === "zcode") {
      // ZCode's own, read now, while ZCode is signed in to this same
      // account. Signed out, or signed in to another account since, it is
      // what it was when this was signed in: another account's key would
      // send this account's requests as that one, and an expired session
      // says sign in again (EXPIRED) rather than borrowing another's.
      const own = ownSignIn()
      // (by user id where both have one: another account may share the name)
      if (own && own.user === String(auth.accountId ?? "") && (!own.uid || !auth.uid || own.uid === String(auth.uid))) {
        const { user, uid: _uid, ...now } = own
        s = { source: "zcode", device: s.device, plan: s.plan, ...now }
      }
    }
    const site = siteOf(s.site)
    const key = s.key ?? (s.jwt ? "" : auth.access)
    // uid is the account's own id, kept beside the name (magpie tells two
    // accounts of one name apart by it). ZCode's event report wants it as
    // user_id (src/claim.mjs's reportActivation): an empty one is a report
    // the server may not count, and the day's plans never appear.
    return { ...s, site, base: s.base || SITES[site].base, key, uid: String(auth.uid ?? s.uid ?? ""), device: s.device || (key ? keyDevice(key) : anyDevice) }
  }
  if (auth?.type === "api") {
    const site = siteOf(auth.metadata?.site)
    const key = String(auth.key ?? "").trim()
    return { site, base: SITES[site].base, key, uid: String(auth.uid ?? ""), device: key ? keyDevice(key) : anyDevice }
  }
  return null
}

export { stateOf }
