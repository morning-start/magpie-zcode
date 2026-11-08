// src/http.mjs —— 插件共享的请求外壳：请求头 / 超时 / 错误出口
//
// 这里只放与厂商无关的协议工具。上游地址、鉴权方式和业务码仍留在各插件的 api.mjs。

import { isModelUnserved } from "./status.mjs"

/**
 * 错误码词表：status 决定宿主如何分流，code 供程序判断，message 给人看。
 */
export const CODES = Object.freeze({
  signInRequired: "sign_in_required", // 401 没凭据 / 从未登录
  sessionExpired: "session_expired", // 401 凭据失效
  auditBlocked: "audit_blocked", // 400 内容被风控拦
  invalidRequest: "invalid_request", // 400 参数不合法
  modelNotFound: "model_not_found", // 404 只搁置这个模型
  concurrencyConflict: "concurrency_conflict", // 409
  rateLimited: "rate_limited", // 429
  upstreamUnavailable: "upstream_unavailable", // 503 上游 5xx
  upstreamTimeout: "upstream_timeout", // 504 超时 / 流被截断
  upstreamError: "upstream_error", // 502 默认桶
  internalError: "internal_error", // 502 插件自己的 bug
  notImplemented: "not_implemented", // 501 不支持的端点 / 能力
})

/**
 * 官方网页客户端的 User-Agent —— 完整合法的 Chrome UA，**不是** `<包名>/<版本号>`。
 *
 * 上游网关按 `<product>/<version>` 形态识别「第三方客户端」，命中即回
 * `403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}` ——
 * 报错说的是「网络繁忙」，看不出是 UA 的锅。而宿主给插件的请求带
 * `User-Agent: magpie/<version>`，插件不显式设就把它透传上去，同样命中。
 *
 * 厂商有 App / CLI 客户端时，把这一个常量换成那个客户端的 UA
 * （`WorkBuddy/<app> … CLI/<ver>`、`aipy-pro/…`、`Loomy|Desktop|Electron|macOS`），
 * 别在这里留 `<包名>/<version>`。判据：`node scripts/check-ua.mjs` 退出 0。
 */
export const OFFICIAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/**
 * 构造公共请求头。UA 默认取 {@link OFFICIAL_UA}；调用方可用 extra 显式覆盖任意默认值。
 *
 * @param {Record<string, string>} [extra] 额外请求头，同名项优先
 * @returns {Record<string, string>}
 */
export function baseHeaders(extra = {}) {
  return {
    "user-agent": OFFICIAL_UA,
    accept: "application/json",
    ...extra,
  }
}

/**
 * 构造带 UTF-8 JSON Content-Type 的 Response。
 *
 * @param {*} body 可 JSON 序列化的响应体
 * @param {number} [status] HTTP 状态码
 * @param {HeadersInit} [headers] 额外响应头，同名项优先
 * @returns {Response}
 */
export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

/**
 * 构造 OpenAI 形状的 JSON 错误响应，并携带宿主需要的状态与登录提示。
 *
 * @param {*} message 错误说明；空值使用默认文案
 * @param {number} status HTTP 状态码，决定宿主换号 / 换模型 / 退避
 * @param {string} code CODES 中的错误码
 * @param {HeadersInit & {signIn?: string}} [extra] 额外响应头与登录提示
 * @returns {Response}
 */
export function errorResponse(message, status, code, extra = {}) {
  const text = String(message ?? "").trim() || "上游没有返回内容"
  const { signIn, ...headers } = extra
  return jsonResponse(
    { error: { message: text, type: code, code, status } },
    status,
    signIn ? { "x-magpie-sign-in": signIn, ...headers } : headers,
  )
}

/**
 * 构造上游业务异常；status 为真值时附加到 Error 上。
 *
 * @param {*} message 异常说明
 * @param {number} [status] 上游 HTTP 状态码
 * @returns {Error & {status?: number}}
 */
export function upstreamError(message, status = 0) {
  const error = new Error(String(message ?? ""))
  if (status) error.status = status
  return error
}

/**
 * 尽量读取响应体：JSON 原样解析，非 JSON 放入 _text，空体或读取失败返回 {}。
 *
 * @param {Response} response 待读取的响应
 * @returns {Promise<*>}
 */
export async function readBody(response) {
  try {
    const text = await response.text()
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return { _text: text }
    }
  } catch {
    return {}
  }
}

/**
 * 从常见错误字段或 HTML 原文中提取简短说明，结果最多 400 个字符。
 *
 * @param {*} body readBody 的结果或任意错误体
 * @returns {string}
 */
export function errorText(body) {
  if (body == null) return ""
  if (typeof body === "string") return body.slice(0, 400)
  const parts = []
  for (const key of ["errmsg", "message", "msg", "error_description", "error", "detail", "code"]) {
    const v = body[key]
    if (v == null || v === "") continue
    parts.push(typeof v === "object" ? JSON.stringify(v) : String(v))
  }
  if (!parts.length && body._text) {
    parts.push(String(body._text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300))
  }
  return parts.join(" · ").slice(0, 400)
}

/**
 * 选择请求取消信号：调用方 signal 优先，否则在 timeoutMs 为正数时创建超时信号。
 *
 * @param {AbortSignal} [signal] 调用方提供的信号
 * @param {number} [timeoutMs] 超时毫秒数
 * @returns {AbortSignal | undefined}
 */
export function abortSignal(signal, timeoutMs) {
  if (signal) return signal
  return Number(timeoutMs) > 0 ? AbortSignal.timeout(timeoutMs) : undefined
}

/**
 * 计算 429 后的等待毫秒数：Retry-After 支持秒数或 HTTP-date。
 * 缺省退避为 5s → 20s → 20s；所有结果钳制在 1–60 秒，避免立即重试或无限等待。
 *
 * @param {Response} response 上游响应
 * @param {number} [attempt] 从 0 开始的第几次等待
 * @param {{now?: () => number}} [options] 可注入当前时间，便于测试 HTTP-date
 * @returns {number}
 */
export function retryAfter(response, attempt = 0, { now = Date.now } = {}) {
  const header = response?.headers?.get?.("retry-after")
  const seconds = header == null
    ? NaN
    : /^\d+$/.test(header.trim())
      ? Number(header)
      : (Date.parse(header) - now()) / 1000
  const fallback = [5000, 20_000][attempt] ?? 20_000
  return Math.min(60_000, Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : fallback))
}

/**
 * 判断上游 401 / 403 是否明确表示登录失效。
 *
 * 401 的纯模型错误不杀账号；401 同时提到鉴权时仍算失效。
 * 403 只有出现明确登录文本才算失效，模型无权限和 bot 拦截都不算。
 *
 * @param {number|string} status 上游 HTTP 状态码
 * @param {*} body readBody 的结果或任意错误体
 * @returns {boolean}
 */
export function isLoginBroken(status, body) {
  const text = errorText(body).toLowerCase()
  if (Number(status) === 401) {
    const authish = /token|key|session|login|登录/.test(text)
    if (authish) return true
    return !isModelUnserved(text)
  }
  if (Number(status) === 403) return /not_logged_in|login|session|csrf|登录|未登录/.test(text)
  return false
}
