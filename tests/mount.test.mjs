import "./support/home.mjs"
import "./support/bun.mjs"
// tests/mount.test.mjs —— 入口 / 九钩子挂载契约（ZCode 版）
//
// 这条测试保护的是「magpie 能不能把插件装起来」，不是 ZCode 的业务语义：
//   ① 入口只导出一个函数（宿主会把每个函数导出都当插件工厂调用）
//   ② _internal 是对象（helper 不暴露成插件）
//   ③ 九项钩子齐全（ZCode 不实现 refresh —— Start Plan 的 token 不能续期、
//      Coding Plan 的 key 不过期，见 HOOKS 五「不续期的情况」）
//   ④ config() 未登录也有模型（否则卡片显示 "0 models"）
//   ⑤ loader() 给 baseURL / apiKey / fetch；未登录返回空对象
//   ⑥ provider.models / chat.headers / usage / checkin 的形状
//   ⑦ 入口只做装配：实现都在 src/
//
// 全部离线；不需要 magpie 进程、不需要凭据。
// 跑法：node --test tests/mount.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"

import * as entry from "../index.mjs"
import { _internal } from "../index.mjs"

const { ZCodeAuthPlugin } = entry
const SOURCE = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")

test("入口只导出一个函数（插件工厂）", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
  assert.deepEqual(functions, ["ZCodeAuthPlugin"])
})

test("_internal 是对象，helper 不暴露成顶层函数导出", () => {
  assert.equal(typeof _internal, "object")
  assert.equal(_internal.PROVIDER, "zcode")
  assert.ok(Array.isArray(_internal.MODELS) && _internal.MODELS.length > 0)
  // 卡片标题是 <中文> <English>（HOOKS 九之三）
  assert.match(_internal.PROVIDER_NAME, /[\u4e00-\u9fa5]/)
  assert.match(_internal.PROVIDER_NAME, /[A-Za-z]/)
  // 状态缓存与纯函数都要能被测试清掉 / 直接调
  for (const key of ["routes", "blocked", "sidelined", "teamKeys", "rateWait", "startGate", "busyHold", "edge"]) {
    assert.ok(_internal[key] !== undefined, `_internal.${key} 必须导出（测试要清）`)
  }
  for (const key of ["plansOf", "giftOf", "dualUsage", "claimDaily", "spentUp", "stateOf", "located", "dress", "sessionOf"]) {
    assert.equal(typeof _internal[key], "function", `_internal.${key} 必须是函数`)
  }
})

test("九项钩子齐全", async () => {
  const plugin = await ZCodeAuthPlugin({ client: {} })
  assert.equal(typeof plugin.config, "function")
  assert.ok(plugin.auth && typeof plugin.auth === "object")
  assert.equal(plugin.auth.provider, "zcode")
  // Start Plan 的 token 不能续期、Coding Plan 的 key 不过期 —— 故意不实现 refresh
  assert.equal(plugin.auth.refresh, undefined, "ZCode 不实现 refresh（见 HOOKS 五）")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.ok(Array.isArray(plugin.auth.methods) && plugin.auth.methods.length >= 4)
  for (const method of plugin.auth.methods) {
    if (method.type === "oauth") assert.equal(typeof method.authorize, "function")
  }
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(plugin.provider.id, "zcode")
  assert.ok(plugin.auth.icon?.startsWith("data:image/"), "图标必须内嵌（外部 URL 在 git 源下不渲染）")
  assert.equal(plugin.auth.maxConcurrency, 3)
  assert.equal(plugin.auth.maxAccounts, 2)
  // 「优先用免费额度」是 magpie 的 auth.options 开关
  const option = plugin.auth.options.find((o) => o.key === "free_first")
  assert.ok(option, "auth.options 必须有 free_first")
  assert.equal(option.default, true)
  assert.equal(typeof option.labels.zh, "string")
})

test("config() 未登录也声明了模型，且 modalities / 五个 input 布尔都在", async () => {
  const plugin = await ZCodeAuthPlugin({ client: {} })
  const cfg = {}
  await plugin.config(cfg)
  const provider = cfg.provider?.zcode
  assert.equal(provider.name, _internal.PROVIDER_NAME)
  assert.equal(provider.npm, "@ai-sdk/anthropic")
  assert.ok(provider.api.startsWith("http"))
  const models = provider.models
  assert.ok(models && Object.keys(models).length > 0, "config.models 不能为空（铁律 1）")
  for (const [id, model] of Object.entries(models)) {
    // config 路径读的是 modalities，不是 capabilities；只写后者等于没写。
    assert.deepEqual(model.modalities.input, ["text"], `${id}.modalities.input 必须给`)
    assert.deepEqual(model.modalities.output, ["text"], `${id}.modalities.output 必须给`)
    // HOOKS 十一之三：capabilities.input 的五个模态键必须是布尔（省略 = 厂商未表态）
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean", `${id}.capabilities.input.${key} 必须是布尔`)
    }
    assert.equal(typeof model.capabilities.output.text, "boolean", `${id}.capabilities.output.text 必须是布尔`)
    assert.equal(typeof model.tool_call, "boolean", "config 路径的工具能力拼写是 tool_call")
  }
})

test("authorize 只启动流程（等登录的是 callback）", async () => {
  const plugin = await ZCodeAuthPlugin({ client: {} })
  for (const method of plugin.auth.methods) {
    if (method.type !== "oauth") continue
    assert.equal(typeof method.authorize, "function")
    // 源码契约：authorize 只把流程启动起来，等用户的是 callback()
    assert.match(SOURCE, /authorize: \(\) => authorize\(site, log\)|authorize: \(inputs\) => authorize\(|authorize: async \(\) => asZCode\(\)/)
  }
  const signin = readFileSync(new URL("../src/signin.mjs", import.meta.url), "utf8")
  assert.match(signin, /async function authorize\(site, log, onTeam = false\)/)
})

test("loader() 给 baseURL / apiKey / fetch；未登录返回空对象", async () => {
  const plugin = await ZCodeAuthPlugin({ client: {} })
  const out = await plugin.auth.loader(async () => ({ type: "oauth", access: "access-token" }), { id: "zcode" })
  assert.equal(typeof out.fetch, "function")
  assert.equal(typeof out.baseURL, "string")
  assert.ok(out.baseURL.startsWith("http"))
  assert.equal(out.apiKey, "access-token")
  // baseURL 指向计划自己的 Anthropic 端点 + /v1
  assert.match(out.baseURL, /\/api\/anthropic\/v1$|\/api\/v1\/zcode-plan\/anthropic\/v1$/)

  const empty = await plugin.auth.loader(async () => null, { id: "zcode" })
  assert.deepEqual(empty, {})
})

test("provider.models：未登录原样交回 magpie 给的列表", async () => {
  const plugin = await ZCodeAuthPlugin({ client: {} })
  const given = { models: { "GLM-5.3": { id: "GLM-5.3" } } }
  const models = await plugin.provider.models(given, { auth: null })
  assert.equal(models, given.models, "未登录时没有可读的目录，交回 provider.models（不要返回空表）")
})

test("chat.headers 只给本 provider 的请求加 x-session-id，且是 UUID 形状", async () => {
  const plugin = await ZCodeAuthPlugin({ client: {} })
  const mine = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "zcode" }, sessionID: "sess-1" }, mine)
  assert.match(mine.headers["x-session-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

  // Agent 给的会话 id 本身是 UUID 时原样发（厂商只该看到 ZCode 的格式）
  const direct = { headers: {} }
  const uuid = "11111111-2222-4333-8444-555555555555"
  await plugin["chat.headers"]({ model: { providerID: "zcode" }, sessionID: uuid }, direct)
  assert.equal(direct.headers["x-session-id"], uuid)

  const other = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "sess-1" }, other)
  assert.deepEqual(other.headers, {})
})

test("usage() 未登录给出 error（不是伪造 0），并保持登录态", async () => {
  const plugin = await ZCodeAuthPlugin({ client: {} })
  const anonymous = await plugin.auth.usage(async () => null, { id: "zcode" })
  assert.equal(typeof anonymous.error, "string")
  assert.equal(anonymous.signIn, "kept")
  assert.equal(anonymous.windows, undefined)
})

test("checkin() 没有 ZCode 登录态时是 ineligible，不是 failed 空转", async () => {
  const plugin = await ZCodeAuthPlugin({ client: {} })
  const out = await plugin.auth.checkin(async () => null, { id: "zcode" })
  assert.equal(out.outcome, "ineligible")
  assert.match(out.message, /ZCode sign-in/)
})

test("入口只做装配：实现都在 src/，入口没有业务函数定义", () => {
  const src = readdirSync(new URL("../src", import.meta.url)).filter((f) => f.endsWith(".mjs"))
  for (const file of [
    "zcode.mjs",
    "plan.mjs",
    "gift.mjs",
    "allowance.mjs",
    "claim.mjs",
    "catalog.mjs",
    "start.mjs",
    "concurrency.mjs",
    "answer.mjs",
    "loader.mjs",
    "signin.mjs",
    "own.mjs",
    "session.mjs",
    "keys.mjs",
    "zai-call.mjs",
    "prompt.mjs",
  ]) {
    assert.ok(src.includes(file), `src/${file} 必须存在（入口靠它装配）`)
  }
  assert.match(SOURCE, /export async function ZCodeAuthPlugin\(/)
  // 入口不该出现顶层函数（除了插件工厂本身）
  const topLevel = [...SOURCE.matchAll(/^(?:export )?(?:async )?function ([A-Za-z0-9_$]+)/gm)].map((m) => m[1])
  assert.deepEqual(topLevel, ["ZCodeAuthPlugin"], `入口只该有插件工厂一个顶层函数，实际：${topLevel.join(", ")}`)
})
