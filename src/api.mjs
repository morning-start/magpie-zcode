// src/api.mjs —— 打上游的那一层，只有这一层知道厂商长什么样
//
// 为什么单独一个文件：四个真实插件（magicrew / officeace / loomy / today）的
// `src/api.mjs` 都是各自仓库里最大的一个文件。钩子里出现的所有网络请求都从这里出，
// 好处是错误语义只在一处定义 —— 而错误语义正是最容易静默出错的地方。
//
// 三个约定，照着写：
//   ① 统一出口 `read()`：非 2xx、业务错误码、坏 JSON 都在这里变成异常
//   ② **模型级错误用 404，不要 401** —— 401 会被 magpie 当成登录失效，整个账号被停
//   ③ 每个请求都带超时（AbortSignal.timeout），没有超时的 fetch 会挂死整张卡片

import { BASE } from "./context.mjs"
import { OFFICIAL_UA, isLoginBroken } from "./http.mjs"

/** 上游给的业务错误。带上 status 与 code，调用方才能分流。 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = "", url = "", body } = {}) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.url = url
    this.body = body
  }
}

/** 默认超时：列表类 10s、对话类 120s（流式另算，别套这个） */
export const TIMEOUT = { short: 10_000, long: 120_000 }

/**
 * 厂商的鉴权头。**每个厂商都不一样，这是本文件里唯一必须改的函数。**
 *
 * 实测踩过的三种：
 *   Bearer <token>                     多数 OpenAI 兼容网关
 *   + organization-code: <org>         有的网关不带这个头直接 500（不是 401）
 *   + 自定义 UA / Origin               有的网关缺 Origin 偶发 403
 *
 * ⚠ UA 写成 `<包名>/<版本号>`（模板早期是 `magpie-plugin/0.0.0`）会被上游网关按
 * 「第三方客户端」拦成 `403 TM.00000001`（文案是「网络繁忙」）。厂商有 App / CLI
 * 客户端就换成那个客户端的 UA，官方是网页就用 `OFFICIAL_UA`（完整 Chrome UA）。
 * 判据：`node scripts/check-ua.mjs` 退出 0。
 */
export function headersFor(auth = {}) {
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": OFFICIAL_UA, // 厂商有 App / CLI 客户端时换成那个 UA
  }
  if (auth.token) h.authorization = `Bearer ${auth.token}`
  // TODO: 需要组织码 / 租户头的话在这里加
  // if (auth.org) h["organization-code"] = auth.org
  return h
}

/**
 * 统一读响应。**所有请求都必须过这里**，否则错误会以各种形状漏到钩子里。
 *
 * 三种失败都要变成异常：
 *   HTTP 非 2xx            → ApiError(status)
 *   200 但业务 code 不等于成功值 → ApiError(code)   ← 最阴的一种，不处理就是「静默空列表」
 *   200 但不是 JSON        → ApiError(原文前 200 字)
 */
export async function read(res, url = "") {
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError(`返回的不是 JSON：${text.slice(0, 200)}`, { status: res.status, url })
  }
  if (!res.ok) {
    throw new ApiError(body?.message || `HTTP ${res.status}`, {
      status: res.status,
      code: String(body?.code ?? ""),
      url,
      body,
    })
  }
  // TODO: 有的厂商 200 里还有业务码（`code: 1000` 表示成功）。不是成功值就抛。
  // if (typeof body?.code === "number" && body.code !== 1000) {
  //   throw new ApiError(body.message || `code ${body.code}`, { status: res.status, code: String(body.code), url })
  // }
  return body
}

/** 带超时的 fetch + 统一读法。请求都该走它。 */
export async function get(path, auth, { timeout = TIMEOUT.short, method = "GET", body } = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`
  const res = await fetch(url, {
    method,
    headers: headersFor(auth),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  return read(res, url)
}

/**
 * 把「这个模型不行」翻译成 404 —— 钩子层的铁律。
 *
 * magpie 的语义：
 *   401 / 403 → 登录失效，整个账号停用（用户要重新登录）
 *   404       → 这个模型不可用，只影响这一次请求
 *   其它      → 透传
 *
 * 上游常常用 4xx 表达「模型没权限 / 不存在」，直接透传就会把整个账号打死。
 */
export function asModelError(e, modelId = "") {
  if (!(e instanceof ApiError)) return e
  const looksLikeModel = /model|模型|not found|不存在|no access|未开通/i.test(String(e.message))
  if (looksLikeModel) {
    return Object.assign(new ApiError(e.message, { status: 404, code: e.code, url: e.url }), {
      modelId,
    })
  }
  return e
}

/**
 * 登录态失效的判据。**只有真的确定失效才抛 signIn: "expired"** ——
 * 抛错的代价是用户要去重新登录一次，误判一次就要骂人。
 */
export function asSignInExpired(message = "登录已失效") {
  return Object.assign(new Error(message), { signIn: "expired" })
}

/** 上游 401/403 必须带明确登录语义才算失效；模型权限 / WAF 403 不误杀账号。 */
export function isAuthFailure(e) {
  return e instanceof ApiError && isLoginBroken(e.status, e.body ?? e.message)
}
