// src/zai-call.mjs —— Z.ai / BigModel / zcode.z.ai 的 JSON 端点调用
//
// 这些端点把话包在 {code, msg, data} 里：code 0 或 200 是成功。错误统一成
// ZError，带 status（宿主据此分流）和 code（3002 之类，用来分清限流和失败）。
// retryAfterMs 也在这里，因为重试语义只该有一处。

import { UA, ZCODE, STATUS_TEXT, first, anyDevice } from "./zcode.mjs"

class ZError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}
// call asks one of Z.ai's JSON endpoints, which wrap what they say in
// {code, msg, data}: a code of 0 or 200 is a success. zcode.z.ai is told
// the machine's id (X-Device-Mid), as ZCode tells it.
async function call(method, url, { auth, body, headers, device, signal } = {}) {
  const h = { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA }
  if (auth) h.Authorization = auth
  if (url.startsWith(ZCODE + "/")) h["X-Device-Mid"] = device || anyDevice
  Object.assign(h, headers ?? {})
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal })
  const text = await res.text()
  let env
  try {
    env = JSON.parse(text)
  } catch {}
  const code = env?.code == null ? "" : String(env.code)
  if (!res.ok) {
    const said = env?.msg ? (code && code !== "0" ? `${env.msg} (${res.status}, code ${code})` : `${env.msg} (${res.status})`) : (STATUS_TEXT[res.status] ?? `${res.status} ${res.statusText}`.trim())
    const err = new ZError(said, res.status)
    err.code = Number(code) || 0 // 3002 and the like: so a caller can tell a rate limit from a failure
    err.retryAfterMs = retryAfterMs(res) // 0 unless the reply carried a Retry-After
    throw err
  }
  if (!env || typeof env !== "object") throw new ZError("not JSON", res.status)
  if (code && code !== "0" && code !== "200") throw new ZError(env.msg || `error ${code}`, res.status)
  return env.data ?? null
}
function retryAfterMs(res) {
  const v = first(res?.headers?.get?.("retry-after"))
  if (!v) return 0
  const secs = Number(v)
  if (Number.isFinite(secs) && secs > 0) return secs * 1000
  const at = Date.parse(v)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0
}

export { ZError, call, retryAfterMs }
