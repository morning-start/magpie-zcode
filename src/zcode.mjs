// ZCode's GLM Coding Plan, as a magpie provider plugin.
//
// ZCode (zcode.z.ai) signs in to a Z.ai account, or a BigModel (智谱,
// bigmodel.cn) one, through a flow zcode.z.ai opens and is polled for. With
// the account's sign-in it finds or makes the coding plan key it uses (the
// key named zcode-api-key in the account's default project) and sends the
// models' requests, Anthropic's Messages, to the plan's endpoint:
// api.z.ai/api/anthropic or open.bigmodel.cn/api/anthropic.
//
// An account with no plan of its own may have a seat on a team's plan (a
// project of type 2, and its zcode-team-api-key), or ZCode's free Start
// Plan, served by zcode.z.ai itself to ZCode's own session token (a JWT
// that can't be refreshed: when it runs out, sign in again).
//
// The sign-in is kept as magpie keeps an OAuth one: `access` is the key,
// `refresh` the rest of it as JSON (site, base, key, jwt, team project,
// plan, device id), `accountId` the account's email.
//
// 本文件只放身份、端点、静态模型表和纯函数：没有状态、不发请求。
// 端点和 app_version 只在这里定义一次 —— ZCode 按 app_version 做门禁
// （营销 feed 对更老的版本回空，Start Plan 的余额也按它判能力），
// 散落到各处就会有人漏带。

import { createHash } from "node:crypto"

const PROVIDER_NAME = "智谱 ZCode"

// UUID is the shape ZCode's client sends in x-session-id: a bare UUID, the same
// on every turn of a conversation. Anything else is made into one (sessionOf).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PROVIDER = "zcode"
// FREE_FIRST is magpie's switch for free first in the provider's editor
const FREE_FIRST = "free_first"
const ZCODE = "https://zcode.z.ai"
const ZAI_API = "https://api.z.ai"
const BIGMODEL_API = "https://bigmodel.cn" // BigModel's business API, where ZCode asks it
const ZAI_BASE = "https://api.z.ai/api/anthropic"
const BIGMODEL_BASE = "https://open.bigmodel.cn/api/anthropic"
const START_BASE = ZCODE + "/api/v1/zcode-plan/anthropic"
// APP_VERSION is the ZCode this signs in and asks as, on every call. ZCode
// gates by it: its marketing feed answers empty to an older one (#678),
// and its Start Plan balance "judges capability by the real app_version"
// (zaiStartPlanBilling.ts in zai-org/ZCode@a9fe401, 3.17.2).
const APP_VERSION = "3.17.2"
const UA = "ZCode/" + APP_VERSION

// ZCode's models before its config is read; the Start Plan has all but GLM-5.3.
const MODELS = [
  { id: "GLM-5.3", context: 1_000_000, output: 128_000, efforts: ["low", "high", "max"] },
  { id: "GLM-5.3-Flash", context: 1_000_000, output: 128_000, efforts: ["low", "high", "max"] },
  { id: "GLM-5.2", context: 1_000_000, output: 128_000, efforts: ["none", "high", "max"] },
  { id: "GLM-5-Turbo", context: 200_000, output: 64_000, efforts: ["none", "high"] },
]
const START_MODELS = MODELS.filter((m) => m.id !== "GLM-5.3")

const SITES = {
  zai: { name: "Z.ai", api: ZAI_API, base: ZAI_BASE, subscribe: "z.ai/subscribe" },
  bigmodel: { name: "BigModel", api: BIGMODEL_API, base: BIGMODEL_BASE, subscribe: "bigmodel.cn/glm-coding" },
}
const siteOf = (s) => (s === "bigmodel" ? "bigmodel" : "zai")

const platform = () => `${process.platform}-${process.arch}` // darwin-arm64, win32-x64, linux-x64, as ZCode names them
const uuid = () => crypto.randomUUID()
const anyDevice = uuid() // X-Device-Mid for calls made signed out (the model list)
// uuidOf is a version 4 shaped UUID made from a seed: the same seed gives
// the same UUID every time
const uuidOf = (seed) => {
  const h = createHash("sha256").update(seed).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
// keyDevice is a device id for an account known only by its key: the same
// key gives the same id on every start, as a sign-in's saved device does
const keyDevice = (key) => uuidOf("zcode-device\0" + key)
const first = (...ss) => ss.map((s) => (typeof s === "string" ? s.trim() : "")).find((s) => s) ?? ""

// STATUS_TEXT is Go's http.StatusText, which magpie's built-in said a
// refusal with no message in.
const STATUS_TEXT = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  408: "Request Timeout", 429: "Too Many Requests",
  500: "Internal Server Error", 503: "Service Unavailable", 504: "Gateway Timeout",
  // Bad Gateway is the upstream's own refusal, not one of this plugin's own
  // list: kept apart here so the error-code check reads the two lists apart.
  502: "Bad Gateway",
}
// ---- the account's plan ----------------------------------------------------------

const rootOf = (base) => {
  try {
    const u = new URL(base)
    return `${u.protocol}//${u.host}`
  } catch {
    return ZAI_API
  }
}
const isTeam = (s) => !!(s.org && s.project)

function jwtExpiry(jwt) {
  const p = String(jwt ?? "").split(".")
  if (p.length !== 3) return 0
  try {
    const claims = JSON.parse(Buffer.from(p[1], "base64url").toString("utf8"))
    return Number(claims.exp) > 0 ? Number(claims.exp) * 1000 : 0
  } catch {
    return 0
  }
}
const jwtExpired = (jwt) => {
  const t = jwtExpiry(jwt)
  return t > 0 && Date.now() > t
}
// EXPIRED is the built-in's words (errZCodeExpired) for a Start Plan
// sign-in past its end.
const EXPIRED = "ZCode's sign-in has expired; sign in to ZCode again (or add the account again in magpie)"

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}
const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))
const isNum = (v) => typeof v === "number" && Number.isFinite(v)
// startNum reads a number the balance gives as a number or a string.
function startNum(v) {
  if (isNum(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim())
    if (!Number.isNaN(n)) return n
  }
  return undefined
}
// periodOf reads an entitlement's period: "daily", "weekly", "monthly".
function periodOf(p) {
  p = p.toLowerCase()
  if (p.includes("day") || p.includes("daily")) return 86400
  if (p.includes("week")) return 7 * 86400
  if (p.includes("month")) return 30 * 86400
  return 0
}
// TEAM marks a team seat's account name beside the account's own.
const TEAM = "team"
const who = (u) => first(String(u?.email ?? "").replace(/@phone\.local$/, ""), u?.name, u?.user_id, "ZCode")
// uidOf is the account's user id, kept beside its name: magpie tells two
// accounts of one name apart by it, a name being no one's own (wakkana on
// Discord, WorkBuddy's)
const uidOf = (u) => (u?.user_id === undefined || u?.user_id === null ? "" : String(u.user_id).trim())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))


export {
  PROVIDER, PROVIDER_NAME, FREE_FIRST, APP_VERSION, UA,
  ZCODE, ZAI_API, BIGMODEL_API, ZAI_BASE, BIGMODEL_BASE, START_BASE,
  SITES, siteOf, platform, uuid, uuidOf, keyDevice, anyDevice, first,
  STATUS_TEXT, rootOf, isTeam, jwtExpiry, jwtExpired, EXPIRED,
  num, compact, isNum, startNum, periodOf,
  TEAM, who, uidOf, sleep, UUID, MODELS, START_MODELS,
}
