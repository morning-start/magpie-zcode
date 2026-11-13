// src/answer.mjs —— 把上游的回答原样交回去，并把「额度用尽」认出来
//
// 插件不改写正常回答（流式尤其不能读），只做两件事：标 X-Magpie-Sign-In: kept，
// 以及把「200 里带着 1113/1005 的余额用尽」说成 429（plugins#817）。

import { busy } from "./concurrency.mjs"

// spentUp is the gift saying it has nothing left to spend: its own no-
// resource-package code 1113, its "exceed quota limit" 1005 — a spent gift
// can answer a 200 with a JSON body carrying one of those codes. Every other
// 429 counts as spent, Z.ai's 1302/1303 rate limits among them; the plan's
// own in-flight cap (3008/3009) does not, since it is a turn not yet come.
function spentUp(text, status) {
  if (busy(status, text)) return false
  if (status === 429) return true
  let b
  try { b = JSON.parse(text) } catch { return false }
  if (!b || typeof b !== "object") return false
  const code = (v) => String(v ?? "")
  const c1 = code(b.code), c2 = code(b.error?.code)
  return c1 === "1113" || c1 === "1005" || c2 === "1113" || c2 === "1005"
}

// spentSaid is an answer that carries spentUp's code inside a 200, as a
// spent bucket's can, said as the 429 it is (plugins#817: a Start Plan
// account's GLM-5.3 out for the day answered 200 "exceed quota limit",
// which magpie took for a reply that did not stream and rested the whole
// account, GLM-5.3-Flash's own bucket with it). Any other answer goes on
// as it came; a stream's body is never read here.
async function spentSaid(res) {
  if (res.status >= 400 || !(res.headers.get("content-type") ?? "").includes("application/json")) return res
  const text = await res.text()
  const status = spentUp(text, res.status) ? 429 : res.status
  return new Response(text, { status, statusText: status === 429 ? "Too Many Requests" : res.statusText, headers: res.headers })
}
// kept passes a response on as it came, the account kept: the built-in
// never marked a ZCode account lapsed nor cleared one.
function kept(res, text) {
  const h = new Headers(res.headers)
  h.delete("content-length")
  h.delete("content-encoding")
  h.set("X-Magpie-Sign-In", "kept")
  return new Response(text !== undefined ? text : res.body, { status: res.status, statusText: res.statusText, headers: h })
}

export { kept, spentUp, spentSaid }
