// src/start.mjs —— Start Plan 的请求整形
//
// zcode.z.ai 只服务「看起来像 ZCode 自己发的」请求：它自己的请求头和请求体。
// 这里把 agent 发来的 Messages 请求改写成 ZCode 的形状（三段 system、当天
// <system-reminder>、metadata.user_id、x-query-id），并把响应里的
// ToolSearchTool 改回 ToolSearch。

import { release, arch } from "node:os"
import { ZCODE, APP_VERSION, UA, platform, uuid, uuidOf, first, STATUS_TEXT, UUID } from "./zcode.mjs"
import PROMPT from "./prompt.mjs"

// ---- the Start Plan's requests ----------------------------------------------------
// zcode.z.ai answers 405 "request has been blocked due to unusual
// activity" (code 3012) to a request that doesn't look like ZCode's own
// (#343: the agent's system prompt as a fourth block), and to every
// request of an account its risk control blocked, ZCode's own app's too
// (plugins#348). A Start Plan request goes as the plugin
// the plan serves (ARNO's "Freeflow", provider zcode-start) sends it: its
// headers (startHeaders) and its body (dress). The texts are prompt.mjs.

// START_RESTRICTED is what ZCode's 3012, "request has been blocked due to
// unusual activity", means: ZCode's risk control blocked the account
// (ZCode's support says so, and ZCode's own app gets the same 405 on such
// an account, plugins#348), not that the request was sent wrong. Word for
// word magpie's provider.ZCodeRestrictedHint: the gateway reads it as the
// account restricted, rests it and asks the group's next member, and the
// Routing page says it in the user's language.
const START_RESTRICTED = "ZCode's risk control blocked this account for unusual activity (code 3012); it rests, and the group's other providers are used. If the ZCode app fails on this account too, only ZCode support can lift the block"
// START_EDGE is what a block page from ZCode's edge firewall (Aliyun's)
// means: this network's address, not the account. Word for word magpie's
// provider.BlockedHint.
const START_EDGE = "the provider's network firewall blocked requests from this IP; wait a while, or switch to another network or proxy"
const EDGE_PAGE = /errors\.aliyun\.com|<html/i
const START_REFUSED = /unusual activity|request has been blocked|"code"\s*:\s*"?3012\b/i

// startRefused says a Start Plan answer is a refusal: a 405, a block page
// or code 3012.
const startRefused = (status, text) => status >= 400 && (status === 405 || START_REFUSED.test(text))

// edge is the hold a block page puts on this computer's address: zcode.z.ai
// (the Start Plan, a gift) is not asked again until edge.until, and its
// requests are answered here with the same 405 and START_EDGE, so magpie
// still reads them as the network's (provider.EdgeBlocked) and asks the
// group's next provider. Every account of this process goes out from the
// one address, so the hold is the process's, not an account's. Asking on
// while the address is blocked, from every account and every session, only
// knocks again on a firewall that is counting (plugins#649: two accounts,
// three sessions and their subagents, and ZCode's own app blocked too; a
// block in #369 lasted about seven minutes). EDGE_HOLD is short enough that
// a user who switched network or proxy waits little for it.
const EDGE_HOLD = 3 * 60_000
const edge = { until: 0 }
const edgeHeld = () => Date.now() < edge.until

function hhmm(t) {
  const d = new Date(t)
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0")
}

// edgeHeldAnswer is a held request's answer: the block page's status and
// meaning, and until when this computer holds off.
function edgeHeldAnswer() {
  const error = { type: "permission_error", message: `405 ${STATUS_TEXT[405]} — ${START_EDGE} (ZCode's Start Plan is not asked again from here until ${hhmm(edge.until)}, plugins#649)` }
  return new Response(JSON.stringify({ type: "error", error }), { status: 405, statusText: STATUS_TEXT[405], headers: { "content-type": "application/json" } })
}

// startBlocked is the refusal's answer: what the vendor said (its status
// for a block page), then what it means. A block page is the network's;
// anything else, ZCode's JSON 3012 or a bare 405, the account's.
function startBlocked(res, text) {
  const page = EDGE_PAGE.test(text)
  let said = ""
  if (!page) {
    try {
      const v = JSON.parse(text)
      said = first(v?.error?.message, typeof v?.error === "string" ? v.error : "", v?.message, v?.msg)
      const code = v?.code ?? v?.error?.code
      if (said && code != null && !String(said).includes(String(code))) said = `${said} (${res.status}, code ${code})`
    } catch {}
  }
  said ||= `${res.status} ${STATUS_TEXT[res.status] ?? res.statusText}`.trim()
  const h = new Headers(res.headers)
  h.set("content-type", "application/json")
  const error = { type: "permission_error", message: `${said} — ${page ? START_EDGE : START_RESTRICTED}` }
  return new Response(JSON.stringify({ type: "error", error }), { status: res.status, statusText: res.statusText, headers: h })
}

const osVersion = () => `${process.platform} ${release()} ${arch()}`
const osCategory = () => (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux")

function intl() {
  try {
    return Intl.DateTimeFormat().resolvedOptions()
  } catch {
    return {}
  }
}

// startHeaders is a Start Plan request's headers, jwt its key: ZCode's
// own (3.16.3's Frn and Vdt in glm/zcode.cjs) and the body's content-type,
// and nothing else. The agent's headers never go on: Claude Code's
// anthropic-beta, x-app, x-stainless-*, anthropic-dangerous-direct-browser-
// access and x-claude-code-session-id reach the plugin through magpie's
// gateway, and ZCode sends none of them (no anthropic-beta at all on the
// Start Plan: its tool search beta is for coding plans only). Accept and
// accept-encoding are left to the HTTP client, as ZCode leaves them to
// Node's.
function startHeaders(h, jwt) {
  const out = new Headers()
  out.set("content-type", h.get("content-type") || "application/json")
  out.set("Authorization", "Bearer " + jwt)
  out.set("anthropic-version", "2023-06-01")
  out.set("HTTP-Referer", ZCODE)
  out.set("User-Agent", UA + " ai-sdk/anthropic/3.0.81")
  out.set("X-ZCode-App-Version", APP_VERSION)
  // the desktop app's agent names itself electron: 3.17.2's
  // zcode-protocol-entrypoint passes sourceTitle "electron", and a bare
  // run under app-server says the same (Mvc in glm/zcode.cjs); "cli" is
  // the zcode command line's alone, which sends no X-Device-Mid on the
  // app's calls and no desktop prompt texts, as this plugin does
  out.set("X-Title", "Z Code@electron")
  out.set("X-Release-Channel", "production")
  const o = intl()
  out.set("X-Client-Language", o.locale || "unknown")
  out.set("X-Client-Timezone", o.timeZone || "unknown")
  out.set("X-ZCode-Agent", "glm")
  out.set("X-Platform", platform())
  out.set("X-Os-Category", osCategory())
  // os.release() alone, as ZCode's buildZCodeSourceHeadersFromContext
  // has it; the prompt's OS line is osVersion()
  out.set("X-Os-Version", release())
  out.set("x-request-id", uuid())
  out.set("x-zcode-session-type", "main")
  out.set("x-zcode-trace-id", uuid())
  // 3.16's createModelRequestAttributionHeaders: what asked the model
  out.set("x-zcode-query-source", "main_turn")
  return out
}

// queryOf is the request's x-query-id, as 3.17.2's
// createModelRequestAttributionHeaders (zft in glm/zcode.cjs) sends it:
// the user's query, "query_" + a UUID with the prefix cut, the same for
// every request of one turn (the tool calls the model makes on the way)
// and a new one for the next thing the user says. The agent's turns are
// counted: a user message that carries text, not tool results alone,
// starts a query. A body that doesn't read gives none, and none is sent.
function queryOf(text, session) {
  let b
  try {
    b = JSON.parse(text)
  } catch {
    return ""
  }
  if (!Array.isArray(b?.messages)) return ""
  let n = 0
  for (const m of b.messages) {
    if (m?.role !== "user") continue
    const c = m.content
    if (typeof c === "string" ? c.trim() : Array.isArray(c) && c.some((x) => x && x.type !== "tool_result")) n++
  }
  return n ? uuidOf("zcode-query\0" + session + "\0" + n) : ""
}

// Claude Code's tool search, as ZCode's plans take it. Claude Code
// (2.1.310) offers a tool named ToolSearch, names its deferred tools in a
// system turn, and sends a deferred tool's schema with defer_loading only
// once a search loaded it (a tool_reference in a ToolSearch result), with
// a DeferredToolPlaceholder that keeps the search on. api.z.ai's
// Anthropic endpoint, given a tool named exactly ToolSearch, shows the
// model none of the other tools, Bash, Read and Write among them, but
// those a tool_reference loaded: a subagent, which hasn't searched,
// reports only the deferred tools, and the main turn has to search for
// Bash before it can run it (小八 on Discord, 10-24; the beta header
// changes nothing, the name alone does). ZCode itself sends no ToolSearch
// and no defer_loading. So the search goes as SEARCH_ALIAS, in the tools
// and in the turns that called it, the tools Claude Code sent with their
// schemas go as ZCode's do, without defer_loading, and the placeholder is
// left out; the model's calls to SEARCH_ALIAS come back as ToolSearch
// (searchNamed).
const SEARCH = "ToolSearch"
const SEARCH_ALIAS = "ToolSearchTool"
const PLACEHOLDER = "DeferredToolPlaceholder"

// searchless is a Messages request body without Claude Code's ToolSearch
// name, and whether it had the tool; anything else goes as it is.
function searchless(text) {
  if (typeof text !== "string" || !text.includes(`"${SEARCH}"`)) return { text, renamed: false }
  let b
  try {
    b = JSON.parse(text)
  } catch {
    return { text, renamed: false }
  }
  if (!b || !Array.isArray(b.tools) || !b.tools.some((t) => t?.name === SEARCH)) return { text, renamed: false }
  // a tool of the alias's own name keeps it; the search can't then be renamed
  if (b.tools.some((t) => t?.name === SEARCH_ALIAS)) return { text, renamed: false }
  b.tools = b.tools
    .filter((t) => t?.name !== PLACEHOLDER)
    .map((t) => {
      if (!t || typeof t !== "object") return t
      const { defer_loading, ...rest } = t
      return t.name === SEARCH ? { ...rest, name: SEARCH_ALIAS } : rest
    })
  if (Array.isArray(b.messages))
    for (const m of b.messages)
      if (m?.role === "assistant" && Array.isArray(m.content))
        for (const x of m.content) if (x?.type === "tool_use" && x.name === SEARCH) x.name = SEARCH_ALIAS
  if (b.tool_choice?.type === "tool" && b.tool_choice.name === SEARCH) b.tool_choice.name = SEARCH_ALIAS
  return { text: JSON.stringify(b), renamed: true }
}

// searchNamed is an answer to a request searchless renamed, the model's
// calls to SEARCH_ALIAS named ToolSearch again, as Claude Code runs them:
// a stream's content_block_start events, or a whole message's content.
function searchNamed(res) {
  if (!res.body) return res
  const type = res.headers.get("content-type") ?? ""
  const named = (block) => {
    if (block?.type === "tool_use" && block.name === SEARCH_ALIAS) {
      block.name = SEARCH
      return true
    }
    return false
  }
  const line = (l) => {
    if (!l.startsWith("data:") || !l.includes(`"${SEARCH_ALIAS}"`)) return l
    try {
      const d = JSON.parse(l.slice(5))
      return named(d?.content_block) ? "data: " + JSON.stringify(d) : l
    } catch {
      return l
    }
  }
  if (type.includes("text/event-stream")) {
    const dec = new TextDecoder()
    const enc = new TextEncoder()
    let held = ""
    const body = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, ctl) {
          held += dec.decode(chunk, { stream: true })
          const i = held.lastIndexOf("\n")
          if (i < 0) return
          ctl.enqueue(enc.encode(held.slice(0, i + 1).split("\n").map(line).join("\n")))
          held = held.slice(i + 1)
        },
        flush(ctl) {
          held += dec.decode()
          if (held) ctl.enqueue(enc.encode(line(held)))
        },
      }),
    )
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
  if (!type.includes("json")) return res
  return res.text().then((text) => {
    let out = text
    if (text.includes(`"${SEARCH_ALIAS}"`)) {
      try {
        const v = JSON.parse(text)
        if (Array.isArray(v?.content) && v.content.map(named).some(Boolean)) out = JSON.stringify(v)
      } catch {}
    }
    return new Response(out, { status: res.status, statusText: res.statusText, headers: res.headers })
  })
}

// startURL is a Start Plan request's URL without the query the agent put
// on it: Claude Code asks /v1/messages?beta=true, which magpie passes on,
// and ZCode asks /v1/messages alone.
function startURL(url) {
  const i = url.indexOf("?")
  return i < 0 ? url : url.slice(0, i)
}

// WORK_DIR and WORK_GIT are where magpie tells a plugin's fetch the agent
// that asked works: the folder, percent-encoded, and "yes" or "no" for a
// git repository, each left off when magpie doesn't know it (magpie's
// provider.WorkDirHeader and WorkGitHeader). They are for the plugin, not
// the vendor.
const WORK_DIR = "x-magpie-work-dir"
const WORK_GIT = "x-magpie-work-git"

// workPlace takes WORK_DIR and WORK_GIT off h: {dir?, git?}, what magpie
// said of where the agent works.
function workPlace(h) {
  const place = {}
  const dir = h.get(WORK_DIR)
  if (dir) {
    try {
      place.dir = decodeURIComponent(dir)
    } catch {}
  }
  const git = h.get(WORK_GIT)
  if (place.dir && (git === "yes" || git === "no")) place.git = git
  h.delete(WORK_DIR)
  h.delete(WORK_GIT)
  return place
}

// environment is the prompt's environment section, as ZCode 3.17.2's
// env-info.ts renders it, bullets one space in. The plugin runs in magpie,
// not in the agent's folder: the working directory and whether it is a git
// repository are the agent's, as magpie tells them (place), and each is
// left out when it isn't told rather than said as magpie's own (#86). The
// agent's shell isn't known here either, so it isn't said; the platform
// and OS version are this computer's, as ZCode's X-Os-* headers say them.
function environment(place = {}) {
  const e = PROMPT.environment
  const lines = [e.heading, e.invokedLine]
  if (place.dir) {
    lines.push(` - ${e.cwdLabel}: ${place.dir}`)
    if (place.git) lines.push(` - ${e.gitLabel}: ${place.git === "yes" ? e.gitYes : e.gitNo}`)
  }
  lines.push(` - ${e.platformLabel}: ${process.platform}`, ` - ${e.osVersionLabel}: ${osVersion()}`)
  lines.push(` - ${e.untrustedNote}`)
  return lines.join("\n")
}

// today is the local date, YYYY-MM-DD.
function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

// contextPrefix is the user turn ZCode puts before the agent's: the day in
// a <system-reminder>, the tags hugging the text, as 3.17.2's current-date
// section says it alone.
function contextPrefix() {
  const c = PROMPT.context
  return { role: "user", content: [{ type: "text", text: "<system-reminder>" + c.currentDateLine.replace("{date}", today()) + "</system-reminder>" }] }
}

// dress is a Messages request body as ZCode sends it: ZCode's three cached
// system blocks and no more, the agent's own system text at the end of the
// third (#343); the context
// prefix as the first turn; no cache mark in the turns but on the last
// block of the last; none on the tools; metadata.user_id naming the
// sign-in's device. site names the powered-by line's provider, place where
// the agent works (workPlace). A body that isn't a Messages request goes as
// it is.
function dress(text, site, device, place, session) {
  if (typeof text !== "string" || !text.includes("messages")) return text
  let b
  try {
    b = JSON.parse(text)
  } catch {
    return text
  }
  if (!b || typeof b !== "object" || !Array.isArray(b.messages)) return text
  const cached = (t) => ({ type: "text", text: t, cache_control: { type: "ephemeral" } })
  const provider = site === "bigmodel" ? "bigmodel-api" : "zai-api"
  const model = typeof b.model === "string" ? b.model : ""
  // The agent's own system text joins the third block, as ZCode's
  // ContextBuilder (3.17.2, core/src/context/builder.ts
  // assembleSystemMessages) joins every dynamic system section, an added
  // one too, with "\n\n" into that one block: ZCode never sends more than
  // three. zcode.z.ai turns a fourth block away with 405/3012 (#343), and
  // the first two must stay byte for byte ZCode's. The third's own
  // sections are 3.17.2's dynamic ones — the unheaded behavior paragraphs,
  // the slash-skill guidance when the request has a Skill tool, the
  // environment and the model, then context management.
  const own = []
  if (typeof b.system === "string") {
    if (b.system.trim()) own.push(b.system)
  } else if (Array.isArray(b.system)) {
    for (const x of b.system) if (x?.type === "text" && typeof x.text === "string" && x.text.trim()) own.push(x.text)
  }
  const skill = Array.isArray(b.tools) && b.tools.some((t) => t && typeof t === "object" && t.name === "Skill")
  const dynamic = [
    PROMPT.dynamicBehavior,
    ...(skill ? [PROMPT.sessionGuidance] : []),
    environment(place),
    ...(model ? [PROMPT.poweredBy.replace("{provider}", provider).replace("{model}", model)] : []),
    PROMPT.contextManagement,
    ...own,
  ]
  b.system = [cached(PROMPT.cliPrefix), cached(PROMPT.stableSections.join("\n\n")), cached("\n\n" + dynamic.join("\n\n"))]
  b.messages = [contextPrefix(), ...b.messages]
  let last = null
  for (const m of b.messages) {
    if (!m || m.role === "system") continue
    last = m
    if (Array.isArray(m.content)) for (const x of m.content) if (x && typeof x === "object") delete x.cache_control
  }
  if (last && typeof last.content === "string") last.content = [cached(last.content)]
  else if (last && Array.isArray(last.content) && last.content.length) {
    const x = last.content[last.content.length - 1]
    if (x && typeof x === "object" && !x.cache_control) x.cache_control = { type: "ephemeral" }
  }
  if (Array.isArray(b.tools)) for (const t of b.tools) if (t && typeof t === "object") delete t.cache_control
  const meta = b.metadata && typeof b.metadata === "object" ? b.metadata : {}
  b.metadata = { ...meta, user_id: userIdOf(device, session) }
  return JSON.stringify(b)
}

// userIdOf is metadata.user_id as ZCode's client (3.14.3, glm/zcode.cjs
// MLs and vWr) puts it on every Anthropic-format request, a coding plan's
// too: the machine's device id, no account uuid. The plan's endpoint keeps
// a prompt cache on the machine it picks by it, so a request without it
// lands anywhere and its cache is mostly missed (#387). Its session_id is
// the request's x-session-id (sessionOf), as ZCode's is.
const userIdOf = (device, session = "") => JSON.stringify({ device_id: device, account_uuid: "", session_id: session })

// marked is a coding plan's Messages request body with metadata.user_id
// as ZCode sends it, when the agent sent none of its own. Anything else,
// a body that isn't a Messages request among them, goes as it is.
function marked(text, device, session) {
  if (typeof text !== "string" || !device || !text.includes("messages")) return text
  let b
  try {
    b = JSON.parse(text)
  } catch {
    return text
  }
  if (!b || typeof b !== "object" || Array.isArray(b) || !Array.isArray(b.messages)) return text
  const meta = b.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata) ? b.metadata : {}
  if (typeof meta.user_id === "string" && meta.user_id.trim()) return text
  b.metadata = { ...meta, user_id: userIdOf(device, session) }
  return JSON.stringify(b)
}

// sessionOf is the x-session-id a request goes with, as ZCode's client
// (3.14.3, glm/zcode.cjs xst and Tst) sends it: a bare UUID, the same on
// every turn of a conversation. BigModel keeps a prompt's cache for the
// requests that name the same session and seldom for those that name none
// (#387). The agent's session (chat.headers below) goes as it is when it is
// a UUID, else as a UUID made from it, so the vendor sees only ZCode's
// format, never magpie's or another agent's; with none, a UUID made from
// the device.
function sessionOf(id, device) {
  const own = typeof id === "string" ? id.trim() : ""
  if (UUID.test(own)) return own.toLowerCase()
  return uuidOf(own ? "zcode-session\0" + own : "zcode-session-device\0" + (device ?? ""))
}

export {
  START_RESTRICTED, START_EDGE, EDGE_PAGE, START_REFUSED, startRefused,
  EDGE_HOLD, edge, edgeHeld, hhmm, edgeHeldAnswer, startBlocked,
  osVersion, osCategory, intl, startHeaders, queryOf,
  SEARCH, SEARCH_ALIAS, PLACEHOLDER, searchless, searchNamed, startURL,
  WORK_DIR, WORK_GIT, workPlace, environment, today, contextPrefix,
  dress, userIdOf, marked, sessionOf,
}
