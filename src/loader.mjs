// src/loader.mjs —— 请求接管（auth.loader）：把 agent 发来的请求改写成 ZCode 的，
// 并把 ZCode 的回答原样交回去
//
// 这里决定三件事，而它们互相纠缠，所以放在一个文件里：
//   ① 请求走哪条路 —— Coding Plan（api.z.ai / open.bigmodel.cn）、团队席位、
//      还是 zcode.z.ai 的 Start Plan（赠送额度）。见 plan.mjs 的 plansOf。
//   ② 请求长什么样 —— Start Plan 只服务「看起来像 ZCode 自己发的」请求
//      （start.mjs 的 dress/startHeaders）；Coding Plan 只在 agent 没给
//      metadata.user_id 时补一个（marked），因为厂商按它认机器、认 prompt 缓存。
//   ③ 一次请求什么时候算结束 —— Start Plan 的在飞槽位要等到回答被读完才放开
//      （concurrency.mjs 的 released），被限流时按 ZCode 自己的客户端重试。
//
// ⚠ 流式回答不要在这里读：`kept()` 只换响应头，body 原样交回去。
// ⚠ 每个错误出口都要带 status，否则宿主不会换号也不会退避。

import { PROVIDER, FREE_FIRST, ZAI_BASE, BIGMODEL_BASE, START_BASE, EXPIRED, isTeam, jwtExpired } from "./zcode.mjs"
import { stateOf } from "./session.mjs"
import { located } from "./own.mjs"
import { plansOf, routes, noPlanKey } from "./plan.mjs"
import { startPlan, giftNames, giftModel, giftUsable, giftRested, giftSidelined, blocked, sidelined, rest, wireModel } from "./gift.mjs"
import { teamKey } from "./keys.mjs"
import { holdKey } from "./claim.mjs"
import {
  startSlot,
  startFull,
  released,
  startQueueAnswer,
  busyHeld,
  busyCap,
  busy,
  busyHeldAnswer,
  askBusy,
} from "./concurrency.mjs"
import {
  edge,
  edgeHeld,
  edgeHeldAnswer,
  EDGE_HOLD,
  EDGE_PAGE,
  startRefused,
  startBlocked,
  startHeaders,
  startURL,
  dress,
  queryOf,
  workPlace,
  sessionOf,
  marked,
  searchless,
  searchNamed,
} from "./start.mjs"
import { kept, spentUp, spentSaid } from "./answer.mjs"
import { modelOf } from "./catalog.mjs"

/**
 * createLoader 造出 auth.loader —— 每个账号跑一次（登录态变化后会重跑）。
 *
 * @param {{client?: any, magpie?: any, options?: any}} [ctx]
 *   宿主上下文：client.auth.set 把团队席位新读到的 key 存回账号；magpie.options 读插件自己的开关
 * @returns {(getAuth: () => Promise<any>, provider?: any) => Promise<any>}
 */
export function createLoader({ client, magpie, options } = {}) {
  return async function loader(getAuth, provider) {
    const s0 = stateOf(await getAuth())
    if (!s0) return {}
    const id = provider?.id ?? "zcode"

    return {
      baseURL: s0.base + "/v1",
      // 真正的 key 由下面的 fetch 放上去（每次重新读 auth，续期后的 key 才是最新的）
      apiKey: s0.key || "zcode",
      async fetch(input, init) {
        // a Start Plan request holds one of its account's slots
        // (startSlot) until its answer has been read to the end
        const own = {}
        try {
          return released(await serve(input, init, own), own.slot, own.signal)
        } catch (e) {
          own.slot?.release()
          throw e
        }
      },
    }

    async function serve(input, init, own) {
      const auth = await getAuth()
      const s = await located(stateOf(auth))
      if (!s) throw new Error("not signed in to ZCode")
      // the account a Start Plan slot belongs to: its user id, which a
      // renewed session keeps, before the key or session itself
      const gateKey = String(auth?.uid || auth?.accountId || holdKey(s))
      let url = input instanceof Request ? input.url : String(input)
      const opts = input instanceof Request
        ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, duplex: "half", ...init }
        : { ...init }
      const { start: alone, gift: known } = await plansOf(s)
      let gift = known
      let key = s.key
      if (isTeam(s) && !key) {
        key = await teamKey(s)
        if (auth?.type === "oauth") {
          const next = { ...auth, refresh: JSON.stringify({ ...s, key }), access: key }
          await client?.auth?.set?.({ path: { id }, body: next }).catch?.(() => {})
        }
      }
      // a dual account's body is read ahead of sending, so a gift that
      // says it is spent can spend nothing and replay what was asked for
      let start = alone
      let orig, forcedGift = false, freeGift = false
      let asked = ""
      let renamed = false
      const done = (res) => (renamed ? searchNamed(res) : res)
      if (opts.body != null) {
        orig = opts.body = typeof opts.body === "string" ? opts.body : await new Response(opts.body).text()
        delete opts.duplex
        // Claude Code's tool search goes under another name, or
        // ZCode's plans show the model no other tool (searchless)
        const plain = searchless(orig)
        if (plain.renamed) {
          orig = opts.body = plain.text
          renamed = true
        }
        let m = modelOf(orig)
        asked = m
        if (m.toLowerCase().endsWith("-trial")) {
          gift ??= await startPlan(s.jwt, s.device).catch(() => null)
          const raw = giftModel(gift, m)
          const available = raw && giftUsable(s, gift, raw)
          if (!available) {
            const error = { type: raw ? "rate_limit_error" : "invalid_request_error", message: raw ? `${giftRested(s, raw) ? `ZCode said the last request for ${raw} was over its quota, so it is not asked again for a minute: ` : ""}ZCode's limited quota for ${raw} is exhausted or temporarily unavailable` : `ZCode has no active limited quota for ${m}` }
            return kept(new Response(JSON.stringify({ type: "error", error }), { status: raw ? 429 : 400, headers: { "content-type": "application/json" } }))
          }
          orig = opts.body = JSON.stringify({ ...JSON.parse(orig), model: wireModel(raw) })
          m = raw
          forcedGift = true
        } else if (!alone && !edgeHeld() && !busyHeld() && !startFull(gateKey) && freeFirst(provider?.options) && s.jwt && known && giftUsable(s, known, m) && !giftSidelined(s, m)) {
          // free first: the plain model spends the account's own live
          // gift before it spends the coding plan, under the name the
          // gift lists. The gift is the route's cache alone (a failed
          // read cached its why), so a gift that cannot be read keeps
          // the request on the plan with no read per request; a
          // gift-only account is already on the gift and is left as
          // it was. A refusal past this check is replayed on the plan
          // in the same request (replayOnPlan below). A busy hold (or
          // a block page) keeps the plain model off the gift: the
          // coding plan is never held, and free first must not move
          // the request onto a route the hold answers 429 without
          // asking. Nor onto a gift whose slots are all taken
          // (startFull): the plan serves it now, the gift only after
          // the others.
          const raw = giftNames(known).find((x) => x.toLowerCase() === m.toLowerCase())
          orig = opts.body = JSON.stringify({ ...JSON.parse(orig), model: wireModel(raw) })
          m = raw
          freeGift = true
        }
        start = alone || forcedGift || freeGift
      }
      const swap = (base) => {
        for (const b of [START_BASE, ZAI_BASE, BIGMODEL_BASE]) {
          if (url.startsWith(b)) {
            url = base + url.slice(b.length)
            break
          }
        }
      }
      let h = new Headers(opts.headers)
      const askedUrl = url
      const place = workPlace(h)
      const sid = sessionOf(h.get("x-session-id"), s.device)
      // restModel is free first's gift turning this model away: the
      // model rests a minute and the route is dropped, so the requests
      // behind it re-read the balance and go straight to the plan. A
      // quota answer rests it in blocked, which a -Trial entry obeys
      // too; any other refusal (spent false) in sidelined, which only
      // free first reads.
      const restModel = (spent) => {
        rest(spent ? blocked : sidelined, s.key + "\0" + s.jwt + "\0" + asked.toLowerCase())
        routes.delete(s.key + "\0" + s.jwt)
      }
      // replayOnPlan is free first's answer to a gift that refused
      // what its own balance read had promised: the model as the
      // agent sent it, the plan's headers, the plan's own patience
      // (askBusy).
      const replayOnPlan = async () => {
        // the gift is done with: its slot goes to the next request
        own.slot?.release()
        let u = askedUrl
        for (const b of [START_BASE, ZAI_BASE, BIGMODEL_BASE]) {
          if (u.startsWith(b)) {
            u = s.base + u.slice(b.length)
            break
          }
        }
        const h2 = new Headers(opts.headers)
        workPlace(h2)
        h2.set("x-session-id", sid)
        h2.delete("authorization")
        h2.set("x-api-key", key)
        h2.set("Authorization", "Bearer " + key)
        h2.delete("content-length")
        opts.body = marked(JSON.stringify({ ...JSON.parse(orig), model: asked }), s.device, sid)
        delete opts.duplex
        return askBusy(u, opts, h2)
      }
      // a block page held this computer off zcode.z.ai (edge): the
      // Start Plan and a picked gift are answered here; free first
      // already left the gift for the plan. Checked before the busy
      // hold: an IP the firewall already refused keeps that behavior
      // (the 405 magpie reads as the network's), hold or no hold.
      if (start && edgeHeld()) return kept(edgeHeldAnswer())
      // a run of busy caps held this computer off zcode.z.ai before the
      // edge firewall could block the IP: a held request is answered
      // here, with a 429 magpie still reads as a rate limit
      if (start && busyHeld()) return kept(busyHeldAnswer())
      // the account's Start Plan slots (startGate): a request past them
      // waits here for one rather than being sent to be refused
      if (start) {
        own.slot = await startSlot(gateKey, opts.signal)
        own.signal = opts.signal
        if (!own.slot) return kept(startQueueAnswer())
        // a hold may have armed while it waited
        if (edgeHeld()) return kept(edgeHeldAnswer())
        if (busyHeld()) return kept(busyHeldAnswer())
      }
      if (start) {
        if (jwtExpired(s.jwt)) throw new Error(EXPIRED)
        if (!s.jwt) throw new Error("ZCode's sign-in has no key; sign in again")
        swap(START_BASE)
        // the Start Plan is served only to what looks like ZCode's own request
        url = startURL(url)
        h = startHeaders(h, s.jwt)
        h.set("x-session-id", sid)
        if (opts.body != null) {
          const text = orig ?? (typeof opts.body === "string" ? opts.body : await new Response(opts.body).text())
          opts.body = dress(text, s.site, s.device, place, sid)
          const q = queryOf(text, sid)
          if (q) h.set("x-query-id", q)
          delete opts.duplex
          h.delete("content-length")
        }
      } else {
        if (!key) throw new Error("ZCode's sign-in has no key; sign in again")
        swap(s.base)
        // a Messages request names the device, as ZCode's does (#387);
        // count_tokens and other paths ZCode never sends go as they are
        if (opts.body != null && /\/v1\/messages$/.test(new URL(url).pathname)) {
          const text = typeof opts.body === "string" ? opts.body : await new Response(opts.body).text()
          const next = marked(text, s.device, sid)
          if (next !== text) h.delete("content-length")
          opts.body = next
          delete opts.duplex
        }
        if (renamed) h.delete("content-length")
        h.set("x-session-id", sid)
        h.delete("authorization")
        h.set("x-api-key", key)
        h.set("Authorization", "Bearer " + key)
      }
      // a refusal that is the account's or the model's own in-flight
      // cap is asked again a moment later (see the plan's concurrency):
      // magpie sends every agent's and every session's requests of this
      // computer through this one process, and its queue spaces them by
      // the number declared above
      let res
      try {
        // Only Start Plan caps count toward the firewall hold: the
        // coding plan is served by another host and was never refused
        // with the IP's 405.
        res = await askBusy(url, opts, h, start ? busyCap : undefined)
      } catch (e) {
        // free first moved the request onto the gift, so a gift that
        // cannot be asked at all — the network, the host — is answered
        // from the plan; the route read is dropped, so the next
        // request learns whether the host is back. A caller's abort
        // stays an abort.
        if (!freeGift || opts.signal?.aborted || e?.name === "AbortError") throw e
        routes.delete(s.key + "\0" + s.jwt)
        res = await replayOnPlan()
      }
      // the Start Plan turning the request away says what to do about
      // it: the account blocked, or the network
      if (start && res.status >= 400) {
        const text = await res.text()
        if (startRefused(res.status, text)) {
          // a key account sent to the Start Plan (its plan list read
          // none) reads its plans again on the next request, so a
          // coding plan that is there after all is used (#369)
          // a block page holds every request off zcode.z.ai a while
          if (EDGE_PAGE.test(text)) edge.until = Date.now() + EDGE_HOLD
          if (freeGift) {
            restModel(false)
            return done(kept(await spentSaid(await replayOnPlan())))
          }
          if (s.key && !forcedGift) routes.delete(s.key + "\0" + s.jwt)
          return kept(startBlocked(res, text))
        }
        res = new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
      }
      // a key with no plan behind it: what Z.ai said, and why a
      // ZCode gift plan can't be had with a key (NO_PLAN_KEY)
      if (!start && !s.jwt && res.status >= 400) {
        const text = await res.text()
        const why = noPlanKey(res, text)
        if (why) return done(kept(why))
        res = new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
      }
      // a trial entry's gift answer that can't serve the request is
      // the agent's answer, not the coding plan's: the user picked the
      // gift, so a spent bucket says 429 (its quota error inside a 200
      // among them) and anything else goes on as it came. A quota
      // answer keeps that model off the gift for a minute, so a rate
      // limit is not knocked twice. A stream's body is never read here.
      if (start && forcedGift) {
        const json = (res.headers.get("content-type") ?? "").includes("application/json")
        if (res.status >= 400 || json) {
          const text = await res.text()
          const spent = spentUp(text, res.status)
          if (!spent && res.status < 400) return done(kept(res, text))
          if (spent) rest(blocked, s.key + "\0" + s.jwt + "\0" + modelOf(orig).toLowerCase())
          return spent && res.status < 400 ? kept(new Response(text, { status: 429, headers: res.headers })) : done(kept(res, text))
        }
      }
      // free first's gift answer: the choice was the plugin's, so the
      // plan answers what the gift would fail — a spent bucket and a
      // refusal like any other 4xx or 5xx among them, the gift's own
      // waited-out busy cap included, since the plan's cap is its own.
      // A spent answer or a block page rests the model a minute and
      // drops the route read; a 401/403 drops the read alone, so the
      // next request learns whether the session is gone. Anything
      // else — a 200 carrying the answer — goes on as it came. A
      // stream's body is never read here.
      else if (start && freeGift) {
        const json = (res.headers.get("content-type") ?? "").includes("application/json")
        if (res.status >= 400 || json) {
          const text = await res.text()
          const cap = busy(res.status, text)
          const spent = !cap && spentUp(text, res.status)
          if (spent) {
            restModel(true)
            return done(kept(await spentSaid(await replayOnPlan())))
          }
          if (res.status >= 400) {
            if (!cap && (res.status === 401 || res.status === 403)) routes.delete(s.key + "\0" + s.jwt)
            return done(kept(await spentSaid(await replayOnPlan())))
          }
          return done(kept(res, text))
        }
      }
      // the plan's answer goes on as it came, the account kept: the
      // built-in never marked a ZCode account lapsed nor cleared one.
      // A spent bucket's 200 says 429 (spentSaid), as a trial
      // entry's does, so magpie rests the model, not the account
      return done(kept(await spentSaid(res)))
    }

    // freeFirst reads the option from the provider config's options first,
    // and from the plugin's own (magpie's Plugins › Options) when the
    // provider carries no freeFirst of its own.
    function freeFirst(providerOptions) {
      return (
        magpie?.options?.(PROVIDER)?.[FREE_FIRST] !== false &&
        (providerOptions?.freeFirst !== undefined ? providerOptions.freeFirst !== false : options?.freeFirst !== false)
      )
    }

    // holdKey names the account a Start Plan slot / wait belongs to.
    function holdKey(s) {
      return s.key || s.jwt
    }
  }
}
