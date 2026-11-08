// tests/mount.test.mjs —— 入口 / 九钩子挂载契约
//
// 结构参照 magpie-loomy-auth/tests/mount.test.mjs（MIT），针对本模板自身：
//   ① 入口只导出一个函数（magpie 会把每个函数导出都当插件工厂调用）
//   ② _internal 是对象（helper 不暴露成插件）
//   ③ 九项钩子齐全
//   ④ config() 未登录也有模型（否则卡片显示 "0 models"）
//   ⑤ authorize() 立刻返回 Promise（当前实现还是 TODO，不把 TODO 的结果当契约）
//   ⑥ loader() 给 baseURL / apiKey / fetch
//   ⑦ usage 构造器可用，窗口形状符合契约
//
// 全部离线；不需要 magpie 进程、不需要凭据。
// 跑法：node --test tests/mount.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import * as entry from "../index.mjs"
import { _internal } from "../index.mjs"
import { usage, usageWindow } from "../src/quota.mjs"

const { XxxAuthPlugin } = entry

test("入口只导出一个函数（插件工厂）", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
  assert.deepEqual(functions, ["XxxAuthPlugin"])
})

test("_internal 是对象，helper 不暴露成顶层函数导出", () => {
  assert.equal(typeof _internal, "object")
  assert.equal(typeof _internal.PROVIDER, "string")
  assert.ok(_internal.PROVIDER.length > 0)
  assert.equal(typeof _internal.staticModels, "function")
  assert.ok(Array.isArray(_internal.MODELS))
})

test("九项钩子齐全", async () => {
  const plugin = await XxxAuthPlugin({ client: {}, directory: undefined })
  assert.equal(typeof plugin.config, "function")
  assert.ok(plugin.auth && typeof plugin.auth === "object")
  assert.equal(plugin.auth.provider, _internal.PROVIDER)
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.ok(Array.isArray(plugin.auth.methods) && plugin.auth.methods.length >= 1)
  assert.equal(typeof plugin.auth.methods[0].authorize, "function")
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(plugin.provider.id, _internal.PROVIDER)
  assert.ok(plugin.auth.icon?.startsWith("data:image/"), "图标必须内嵌（外部 URL 在 git 源下不渲染）")
  assert.ok(Number.isInteger(plugin.auth.maxConcurrency) && plugin.auth.maxConcurrency >= 1)
})

test("config() 未登录也声明了模型，且 modalities / 五个 input 布尔都在", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const cfg = {}
  await plugin.config(cfg)
  const models = cfg.provider?.[_internal.PROVIDER]?.models
  assert.ok(models && Object.keys(models).length > 0, "config.models 不能为空（铁律 1）")
  for (const [id, model] of Object.entries(models)) {
    // config 路径读的是 modalities，不是 capabilities；只写后者等于没写。
    assert.deepEqual(model.modalities.input, ["text"], `${id}.modalities.input 必须给`)
    assert.deepEqual(model.modalities.output, ["text"], `${id}.modalities.output 必须给`)
    // HOOKS 十一之三只规定了 capabilities.input 的五个模态键；output 不发明字段
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean", `${id}.capabilities.input.${key} 必须是布尔`)
    }
    assert.equal(typeof model.capabilities.output.text, "boolean", `${id}.capabilities.output.text 必须是布尔`)
  }
})

test("authorize 是 async 函数（不在测试里调用 TODO 实现）", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const method = plugin.auth.methods[0]
  assert.equal(typeof method.authorize, "function")
  // 当前 startLoginFlow 仍是 TODO（调用会 reject）。这里只锁「存在 + async 形状」，
  // 不把 TODO 的实现结果当契约；实现后由派生仓库的 live 测试覆盖真实返回。
  assert.equal(method.authorize.constructor.name, "AsyncFunction")
})

test("loader() 给 baseURL / apiKey / fetch；未登录返回空对象", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const out = await plugin.auth.loader(async () => ({ type: "oauth", access: "access-token" }), { id: "xxx" })
  assert.equal(typeof out.fetch, "function")
  assert.equal(typeof out.baseURL, "string")
  assert.ok(out.baseURL.startsWith("http"))
  assert.equal(out.apiKey, "access-token")

  const empty = await plugin.auth.loader(async () => null, { id: "xxx" })
  assert.deepEqual(empty, {})
})

test("provider.models：未登录返回静态模型表；条目 API 字段完整", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const models = await plugin.provider.models({}, { auth: null })
  assert.ok(models && Object.keys(models).length > 0)
  for (const [id, model] of Object.entries(models)) {
    assert.equal(model.id, id)
    assert.equal(model.api.url, _internal.BASE)
    assert.equal(model.api.npm, "@ai-sdk/openai-compatible")
  }
})

test("usage 构造器可用：至少造一条参与路由的窗口", () => {
  const value = usage({
    plan: "Test",
    windows: [usageWindow({ name: "5 小时", used: 37, span: 18_000, resetsAt: "2026-10-30T12:00:00Z" })],
  })
  assert.equal(typeof value.plan, "string")
  assert.equal(value.windows.length, 1)
  assert.equal(Number.isFinite(value.windows[0].used), true)
  assert.equal(typeof value.windows[0].aside === "boolean" || value.windows[0].aside === undefined, true)
})

test("usage() 未登录 / TODO 未实现时给出 error 而不是伪造 0", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const anonymous = await plugin.auth.usage(async () => null, { id: "xxx" })
  assert.equal(anonymous.error, "未登录")
  assert.deepEqual(anonymous.windows, [])

  const withAuth = await plugin.auth.usage(async () => ({ type: "oauth", access: "x" }), { id: "xxx" })
  assert.equal(typeof withAuth.error, "string", "TODO 抛错时必须把原因交给卡片")
  assert.deepEqual(withAuth.windows, [])
})

test("chat.headers 只给本 provider 的请求加头", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const header = `x-${_internal.PROVIDER}-session`
  const mine = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: _internal.PROVIDER }, sessionID: "sess-1" }, mine)
  assert.equal(mine.headers[header], "sess-1")

  const other = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "sess-1" }, other)
  assert.deepEqual(other.headers, {})
})

test("usage/checkin 的账号 key 用 uid 或凭据指纹，不用可重名的 accountId", () => {
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
  assert.match(source, /const usageKey = uidOf\(auth\)/)
  assert.match(source, /const account = uidOf\(auth\)/)
  assert.doesNotMatch(source, /auth\.uid \?\? auth\.accountId/)
  assert.doesNotMatch(source, /auth\.uid \|\| auth\.accountId/)
})

test("refresh-only OAuth 不会被 usage/checkin 的账号 key 误判为未登录", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const getAuth = async () => ({ type: "oauth", refresh: "refresh-only-credential", accountId: "duplicate-display-name" })

  const usage = await plugin.auth.usage(getAuth, { id: "xxx" })
  assert.notEqual(usage.error, "未登录")
  assert.match(usage.error, /TODO/)

  const checkin = await plugin.auth.checkin(getAuth, { id: "xxx" })
  assert.equal(checkin.outcome, "failed")
  assert.notEqual(checkin.message, "未登录")
  assert.match(checkin.message, /TODO/)
})

test("auth.usage 接入 SWR，并给无旧值读取设置上限", () => {
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
  assert.match(source, /usageCache\.readSWR\(String\(usageKey\), \(\) => fetchUsage\(auth\), \{ timeoutMs: 10_000 \}\)/)
})

test("auth.checkin 按账号走 single-flight，且不回放成功结果", () => {
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
  assert.match(source, /const checkinLock = createRefreshLock\(\{ replayMs: 0 \}\)/)
  assert.match(source, /return checkinLock\.run\(key, async \(\) =>/)
  assert.match(source, /const key = `\$\{provider\?\.id \|\| PROVIDER\}\\n\$\{account\}`/)
})

test("auth.refresh 走 refresh lock，而不是裸调 exchangeRefresh", () => {
  // 模板里的 exchangeRefresh 仍是 TODO，无法注入桩；用源码契约锁住接线本身。
  // 模块行为由 tests/refresh-lock.test.mjs 锁，这里只防止未来重构把闸拆掉。
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
  assert.match(source, /import \{ createRefreshLock \} from "\.\/src\/refresh-lock\.mjs"/)
  assert.match(source, /refreshLock\.run\(\s*`\$\{PROVIDER\}\\n\$\{auth\.refresh\}`/)
})
