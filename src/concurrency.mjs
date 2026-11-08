// src/concurrency.mjs —— 一个账号同时在飞的请求数
//
// ZCode 对同一账号只服务少数几个并发请求，超了回 429 code 3008/3009/3010
// （「当前系统繁忙」）。这里复刻 ZCode 自己的客户端：3 个在飞、排队等，
// 被拒后 1s、2s 再问；连续被拒则整台机器暂停一会儿，免得把 IP 送进防火墙。

import { STATUS_TEXT, sleep, first } from "./zcode.mjs"

// ---- the plan's concurrency ------------------------------------------------------
// ZCode serves one account a few requests at a time. Past that it answers 429
// with code 3008, "user concurrency limit exceeded", 3009, "model
// concurrency limit exceeded", or 3010: the request's turn has not come — not
// a plan spent (1113/1005) and not a rate limit (1302/1303). ZCode's own
// client (3.17.2) reads the three as one ("当前系统繁忙"), asks again after 1s
// and 2s, and then gives up; it sends one request per session at a time and
// has no hold. magpie sends every agent's and every session's requests of
// this computer through this one process, so the plugin does what that
// client does: the Start Plan gets a few requests of an account in flight at
// once (startGate), the rest wait their turn here instead of being sent to be
// refused, and a refusal anyway is asked again twice (BUSY_WAITS).
//
// The coding plan keeps no gate of the plugin's: its cap depends on its tier
// (Z.ai serves Max more at once than Pro, and Lite fewer) and is higher
// off-peak (https://docs.z.ai/devpack/usage-policy), so a number written here
// would hold a Max account to a Lite one's. magpie's own queue spaces it by
// the number declared below (DEFAULT_CONCURRENCY, on the auth hook and in
// package.json), which a user raises on the account.
const DEFAULT_CONCURRENCY = 3
// DEFAULT_ACCOUNTS is how many of a user's ZCode accounts magpie sends
// requests to at the same time (maxAccounts, on the auth hook and in
// package.json): the first in the user's list, the next taking over once
// one runs out or fails. 01huadalang on Discord: three accounts used at
// once from one address got the address refused with a 405, two didn't. A
// user sets their own on the provider (Accounts at once), 0 for no limit.
const DEFAULT_ACCOUNTS = 2
const BUSY_CODES = new Set(["3008", "3009", "3010"])
// BUSY_WAITS are the waits before each ask again: ZCode's own client's,
// 1s and 2s (kqo in its bundle). Past them the cap goes back to magpie,
// which takes the request to another account or rests this one as its 429
// says. Six asks over ten seconds, before 0.1.56, put two or three times the
// requests a capped account could serve on the wire, and the agents' own
// retries came on top.
const BUSY_WAITS = [1000, 2000]
// The hint names neither "plan" nor "limit": after the vendor's "…limit
// exceeded" either would read to magpie as a plan used up.
const BUSY_HINT =
  "ZCode serves one account a few requests at a time and was still busy when asked again after 1s and 2s; run fewer agents or subagents on ZCode at once, or try again in a moment"

// startGate is the Start Plan's in-flight count per account. PR #395 measured
// one Z.ai gift account at 3 of 12 parallel requests served in one run and 4
// of 12 in another, so three are in flight at once, what magpie's queue sends
// by DEFAULT_CONCURRENCY too. The gate holds them there when that queue
// doesn't: a user who raised the account's number for the coding plan, two
// magpie providers signed in to one account, a host that doesn't read
// maxConcurrency. A cap the server still says now and then (a slot it lets
// go of late, the ZCode app on the same account) the 1s re-ask gets past.
// A request past them waits here, first come first served, until one is
// answered to the end, up to startGate.wait; an agent that gives up leaves
// the queue. A wait that runs out is answered startQueueAnswer's 429,
// nothing sent. The gate lives in this process's memory alone, by account
// (gateKey).
const startGate = { inflight: 3, wait: 120_000, lanes: new Map() }

// startFull says the account's Start Plan slots are all taken, or others wait.
const startFull = (key) => {
  const l = startGate.lanes.get(key)
  return !!l && (l.busy >= startGate.inflight || l.queue.length > 0)
}

// startSlot waits for one of the account's Start Plan slots: { release },
// null when startGate.wait ran out first, or the agent's abort thrown.
function startSlot(key, signal) {
  const lanes = startGate.lanes
  let l = lanes.get(key)
  if (!l) lanes.set(key, (l = { busy: 0, queue: [] }))
  const next = () => {
    while (l.busy < startGate.inflight && l.queue.length) l.queue.shift()()
    if (!l.busy && !l.queue.length && lanes.get(key) === l) lanes.delete(key)
  }
  const take = () => {
    l.busy++
    let gone = false
    return {
      release() {
        if (gone) return
        gone = true
        l.busy--
        next()
      },
    }
  }
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"))
  if (l.busy < startGate.inflight && !l.queue.length) return Promise.resolve(take())
  return new Promise((resolve, reject) => {
    const leave = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", aborted)
      const i = l.queue.indexOf(go)
      if (i >= 0) l.queue.splice(i, 1)
    }
    const go = () => {
      leave()
      resolve(take())
    }
    const aborted = () => {
      leave()
      next()
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"))
    }
    const timer = setTimeout(() => {
      leave()
      next()
      resolve(null)
    }, startGate.wait)
    signal?.addEventListener?.("abort", aborted, { once: true })
    l.queue.push(go)
  })
}

// released hands res on and lets its slot go once ZCode's answer has come
// to its end, failed, or been given up on (the agent's abort, the reader's
// cancel) — the request is in flight at ZCode until then. The answer is read
// as it comes, whether or not the agent reads it yet, so a reply read late,
// or dropped unread, does not keep its slot past ZCode's own end of it.
function released(res, slot, signal) {
  if (!slot) return res
  if (!res.body) {
    slot.release()
    return res
  }
  const reader = res.body.getReader()
  const stop = (why) => {
    slot.release()
    reader.cancel(why).catch(() => {})
  }
  signal?.addEventListener?.("abort", () => slot.release(), { once: true })
  const pump = async (c) => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        c.enqueue(value)
      }
      slot.release()
      c.close()
    } catch (e) {
      slot.release()
      try {
        c.error(e)
      } catch {}
    }
  }
  // started, not awaited: the agent reads each chunk as it comes
  const body = new ReadableStream({ start: (c) => void pump(c), cancel: stop })
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

// startQueueAnswer is a request that waited its whole turn behind the
// account's others and was never sent: a 429 magpie reads as a rate limit,
// so it tries the next account, and a short Retry-After.
function startQueueAnswer() {
  const error = {
    type: "rate_limit_error",
    message: `ZCode's free Start Plan serves this account ${startGate.inflight} requests at a time; this one waited ${Math.round(startGate.wait / 1000)}s behind the others and was not sent. Run fewer agents or subagents on ZCode at once, or try again`,
  }
  return new Response(JSON.stringify({ type: "error", error }), {
    status: 429, statusText: STATUS_TEXT[429], headers: { "content-type": "application/json", "retry-after": "5" },
  })
}

// busyHold is the firewall's countdown. Two days of logs (11-05 23:06–23:15
// and 11-06 06:23–06:27) show the same shape: sustained ~18 requests/min on
// the Start Plan, up to ~10 of them in flight against a cap of about three,
// brings code-3008 caps in a run, and 3–7.5 minutes later the edge firewall
// (errors.aliyun.com) refuses the whole IP with 405 for 1–2 hours. Re-asks
// absorbed ~90% of those caps, so neither magpie nor the agent saw that the
// address was saturated and nobody slowed the arrival rate down. startGate
// now keeps this computer's own requests under the cap, so a cap is ZCode
// busy or another client on the account; a request refused on its first ask
// and again a second later (busyCap) is that, sustained, and BUSY_N of them
// in one minute hold the Start Plan (zcode.z.ai only, process-wide, every
// account) off BUSY_HOLD. A cap the 1s re-ask got past counts for nothing:
// on 0.1.55 every capped request counted, a lone late slot as much as a
// saturated address, and busy afternoons held users for nothing. Replay of
// both days: N=5, H=3min froze 2–7 minutes before the first 405 and spared
// 37–52 requests. A held request answers 429 with Retry-After, so magpie
// still reads a rate limit, rests the account and fails over; it is not the
// 405/BlockedHint of an IP already refused. The coding plan, on another
// host, is never held. The hold lives in this process's memory alone: magpie
// restarting forgets it. Only model requests are held — balance reads, the
// usage card and check-in still reach zcode.z.ai during it (the check-in
// holds its own reads per account on a 429).
const BUSY_N = 5
const BUSY_WINDOW = 60_000
const BUSY_HOLD = 3 * 60_000
const busyHold = { hits: [], until: 0, now: () => Date.now() }
// busyHold.now is the clock, injectable for tests: a hold's window, its
// length and its expiry all read through it.
const busyHeld = () => busyHold.now() < busyHold.until

// busyCap records one sustained concurrency cap of a Start Plan request.
// Only a run arms a hold; the window is cleared on arming, and a cap that
// lands while the hold is on counts toward nothing — the hold's own 429s and
// the first caps after it cannot keep re-arming it.
function busyCap() {
  if (busyHeld()) return
  const now = busyHold.now()
  busyHold.hits.push(now)
  while (busyHold.hits.length && now - busyHold.hits[0] > BUSY_WINDOW) busyHold.hits.shift()
  if (busyHold.hits.length >= BUSY_N) {
    busyHold.until = now + BUSY_HOLD
    busyHold.hits.length = 0
  }
}

function busyHeldAnswer() {
  const wait = Math.max(1, Math.ceil((busyHold.until - busyHold.now()) / 1000))
  const error = {
    type: "rate_limit_error",
    message: `ZCode turned away ${BUSY_N} requests in the last minute as too many requests at once, each again when asked a second later. So that ZCode's firewall does not block this network, magpie sends no free Start Plan requests for the next ${wait}s. Wait, run fewer agents or subagents on ZCode at once, or use a GLM Coding Plan model`,
  }
  return new Response(JSON.stringify({ type: "error", error }), {
    status: 429, statusText: STATUS_TEXT[429], headers: { "content-type": "application/json", "retry-after": String(wait) },
  })
}

// busy says a 429 is that in-flight cap: its own code (3008, 3009, 3010), or its
// own words when the envelope carries no code.
function busy(status, text) {
  if (status !== 429) return false
  let b
  try {
    b = JSON.parse(text)
  } catch {
    return false
  }
  if (!b || typeof b !== "object") return false
  const say = (v) => (v == null || typeof v === "object" ? "" : String(v))
  if (BUSY_CODES.has(say(b.code) || say(b.error?.code))) return true
  return /concurrency limit exceeded/i.test(say(b.msg) + " " + say(b.message) + " " + say(b.error?.message) + " " + say(b.error))
}

// busyAnswer is the vendor's cap refusal as the agent reads it: its words,
// then what they are and what to do, as noPlanKey says why a key has no plan.
function busyAnswer(res, text) {
  const h = new Headers(res.headers)
  h.set("content-type", "application/json")
  let v
  try {
    v = JSON.parse(text)
  } catch {}
  if (v && typeof v === "object") {
    const said = first(v.msg, v.message, v.error?.message, typeof v.error === "string" ? v.error : "", `${res.status}`)
    const code = v.code ?? v.error?.code
    const head = code != null && !said.includes(String(code)) ? `${said} (${res.status}, code ${code})` : said
    const message = `${head} — ${BUSY_HINT}`
    const out = v.error && typeof v.error === "object" ? { ...v, error: { ...v.error, message } } : { ...v, msg: message }
    return new Response(JSON.stringify(out), { status: res.status, statusText: res.statusText, headers: h })
  }
  return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `${res.status} ${STATUS_TEXT[res.status] ?? res.statusText} — ${BUSY_HINT}`.trim() } }), {
    status: res.status,
    statusText: res.statusText,
    headers: h,
  })
}

// askBusy asks once and, when the answer is the vendor's in-flight cap
// (3008/3009/3010, or its own words), asks again after BUSY_WAITS's waits,
// 1s and then 2s, as ZCode's own client does. Past them the cap goes back as
// busyAnswer's 429. A request refused again at its 1s re-ask is a sustained
// cap, told to onCap once (the firewall hold's count); one the re-ask got
// past is not. The plan path's patience, shared with free first's replay,
// whose plan has a cap of its own.
async function askBusy(u, o, hs, onCap) {
  let res = await fetch(u, { ...o, headers: hs })
  let caps = 0
  for (let i = 0; res.status === 429; i++) {
    const text = await res.text()
    const cap = busy(429, text)
    // one request's refusals are one saturation signal, not one per ask
    if (cap && ++caps === 2) onCap?.()
    // the hold armed: a request already in flight stops asking too. The
    // second check catches the asks that capped before the hold armed and
    // woke from their wait after it. Keying on onCap keeps the coding plan
    // and free first's replay (no onCap) as they are.
    if (cap && onCap && busyHeld()) { res = busyHeldAnswer(); break }
    if (!cap || i >= BUSY_WAITS.length) {
      res = cap ? busyAnswer(res, text) : new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
      break
    }
    await sleep(BUSY_WAITS[i])
    if (onCap && busyHeld()) { res = busyHeldAnswer(); break }
    res = await fetch(u, { ...o, headers: hs })
  }
  return res
}

export {
  DEFAULT_CONCURRENCY, DEFAULT_ACCOUNTS, BUSY_CODES, BUSY_WAITS, BUSY_HINT,
  startGate, startFull, startSlot, released, startQueueAnswer,
  BUSY_N, BUSY_WINDOW, BUSY_HOLD, busyHold, busyHeld, busyCap, busyHeldAnswer,
  busy, busyAnswer, askBusy,
}
