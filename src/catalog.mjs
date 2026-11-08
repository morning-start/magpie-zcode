// src/catalog.mjs —— ZCode 的模型目录（provider 配置 → 模型条目）
//
// ZCode 的模型表不在公开 API 里，而在它自己的 provider 配置里：在线那份由
// zcode.z.ai 的 client/configs 给出地址，离线那份在已安装 ZCode 的
// runtime/provider/**/zcode-builtin.json。两者取 revision 更新的那份。

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { PROVIDER, ZCODE, APP_VERSION, platform, UA } from "./zcode.mjs"
import { call } from "./zai-call.mjs"

// ---- models ----------------------------------------------------------------------

// planID is ZCode's providerId for the plan served at base; a team's plan
// has the individual one's models.
const planID = (base) =>
  base.includes("/zcode-plan/")
    ? "account:zai-start-plan"
    : base.includes("bigmodel.cn")
      ? "account:bigmodel-individual-coding-plan"
      : "account:zai-individual-coding-plan"

const efforts = (vs) => [...new Set(vs.map((v) => (v === "disabled" ? "none" : v === "enabled" ? "high" : v)))]

// modelsOf is a plan's models in ZCode's provider config.
function modelsOf(cfg, plan) {
  const c = cfg?.config ?? {}
  const ids = []
  const on = new Set()
  const add = (id) => {
    if (!on.has(id.toLowerCase())) on.add(id.toLowerCase()), ids.push(id)
  }
  for (const r of c.providerConfigRules?.providerRules ?? []) if (r.providerId === plan) (r.builtinModelIds ?? []).forEach(add)
  const off = new Set()
  for (const r of c.modelConfigRules?.builtinProviderModelRules ?? []) {
    if (r.providerId !== plan) continue
    if (r.config?.enabled === false) off.add(String(r.modelId).toLowerCase())
    else add(r.modelId)
  }
  const out = []
  for (const id of ids) {
    if (off.has(id.toLowerCase())) continue
    const m = { id, context: 0, output: 0, efforts: [] }
    for (const r of c.modelConfigRules?.modelRules ?? []) {
      let re
      try {
        re = new RegExp(`^(?:${r.modelMatch})$`, "i")
      } catch {
        continue
      }
      if (!re.test(id)) continue
      const x = r.config ?? {}
      if (x.properties?.contextWindow > 0) m.context = x.properties.contextWindow
      if (x.optionSpecs?.maxOutputTokens?.max > 0) m.output = x.optionSpecs.maxOutputTokens.max
      if (typeof x.properties?.inputFormat?.supportsImage === "boolean") m.image = x.properties.inputFormat.supportsImage
      if (x.optionSpecs?.reasoningLevel?.values?.length) m.efforts = efforts(x.optionSpecs.reasoningLevel.values)
    }
    out.push(m)
  }
  return out
}

// localConfig is the latest provider config an installed ZCode has.
function localConfig() {
  const files = []
  const rt = join(zcodeDir(), "runtime", "provider")
  const walk = (dir, depth) => {
    let es = []
    try {
      es = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (depth < 3 && e.isDirectory()) walk(join(dir, e.name), depth + 1)
      else if (depth === 3 && e.name === "zcode-builtin.json") files.push(join(dir, e.name))
    }
  }
  walk(rt, 0)
  if (process.platform === "darwin") files.push("/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json")
  let best = null
  for (const f of files) {
    try {
      if (!existsSync(f)) continue
      const b = JSON.parse(readFileSync(f, "utf8"))
      if (!best || (b.revision ?? 0) > (best.revision ?? 0)) best = b
    } catch {}
  }
  return best
}

// remoteConfig is the release of ZCode's provider config zcode.z.ai names now.
async function remoteConfig() {
  const signal = AbortSignal.timeout(8000)
  const c = await clientConfigs()
  const url = c?.configs?.builtin_provider_config_json
  if (!String(url ?? "").startsWith("https://")) throw new Error("ZCode's configs name no provider config")
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal })
  if (!res.ok) throw new Error(`ZCode's provider config: ${res.status}`)
  return res.json()
}

// clientConfigs is what zcode.z.ai tells this client version
// (/api/v1/client/configs): the provider config's address, and the
// captcha its claims and requests need (claimNeedsCaptcha). A read that
// came through is kept for 10 minutes; a failed one is not kept, and
// throws.
let clientCache = null
async function clientConfigs() {
  if (clientCache && Date.now() - clientCache.at < 600_000) return clientCache.c
  const c = await call("GET", `${ZCODE}/api/v1/client/configs?app_version=${APP_VERSION}&platform=${platform()}`, { signal: AbortSignal.timeout(8000) })
  clientCache = { c, at: Date.now() }
  return c
}
// resetClientConfigs is for tests: the next read asks zcode.z.ai again.
function resetClientConfigs() {
  clientCache = null
}

// config is ZCode's provider config, the later of zcode.z.ai's and an
// installed ZCode's, kept for 10 minutes.
let cfgCache = null
async function zcodeConfig() {
  if (cfgCache && Date.now() - cfgCache.at < 600_000) return cfgCache.cfg
  let cfg = null
  try {
    cfg = await remoteConfig()
  } catch {}
  const local = localConfig()
  if (local && (!cfg || (local.revision ?? 0) > (cfg.revision ?? 0))) cfg = local
  cfgCache = { cfg, at: Date.now() }
  return cfg
}

// variants are a model's reasoning efforts as @ai-sdk/anthropic options.
const BUDGET = { minimal: 1024, low: 4096, medium: 8192, high: 16_000, max: 31_999 }
function variants(es) {
  const out = {}
  for (const e of es) out[e] = e === "none" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled", budgetTokens: BUDGET[e] ?? 16_000 } }
  return out
}

// entry is a model as a config hook declares it.
//
// ⚠ config 路径读的是 `modalities`（不是 capabilities），但 `capabilities.input`
// 的五个模态键必须**显式写成布尔**：省略不等于 text，等于「厂商未表态」，
// magpie 会退到 models.dev 按裸模型 id 投票补 —— 收不了图的模型会被当成能收图
// （AGENTS 坑 25）。两个位置都写，避免只写一处时读不到。
const TEXT_ONLY_INPUT = { text: true, image: false, audio: false, video: false, pdf: false }
const entry = (m) => ({
  id: m.id,
  name: m.id,
  reasoning: m.efforts.some((e) => e !== "none"),
  tool_call: true,
  attachment: !!m.image,
  modalities: { input: m.image ? ["text", "image"] : ["text"], output: ["text"] },
  capabilities: {
    temperature: true,
    reasoning: m.efforts.some((e) => e !== "none"),
    toolcall: true,
    attachment: !!m.image,
    input: { ...TEXT_ONLY_INPUT, image: !!m.image },
    output: { text: true },
  },
  // what ZCode's config names, else 0 (unknown), as magpie's built-in
  limit: { context: m.context || 0, output: m.output || 0 },
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  variants: variants(m.efforts),
})

// model is a model as OpenCode's provider hands it to provider.models.
// modelOf reads the model a Messages body asks for.
function modelOf(text) {
  try {
    const m = JSON.parse(text)?.model
    return typeof m === "string" ? m : ""
  } catch {
    return ""
  }
}

function model(m, url) {
  const e = entry(m)
  return {
    id: m.id,
    providerID: PROVIDER,
    name: m.id,
    api: { id: m.id, url, npm: "@ai-sdk/anthropic" },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: e.limit,
    options: {},
    headers: {},
    capabilities: {
      temperature: true,
      reasoning: e.reasoning,
      attachment: e.attachment,
      toolcall: true,
      input: { text: true, image: !!m.image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: e.variants,
  }
}

// config 设置 zcodeConfig 读过什么，供测试用：null 表示 ZCode 的配置读不到，
// undefined 表示忘掉它。测试之外的代码不会调它。
function config(cfg) {
  cfgCache = cfg === undefined ? null : { cfg, at: Date.now() }
}

export {
  BUDGET, planID, efforts, modelsOf, localConfig, remoteConfig, clientConfigs,
  resetClientConfigs, zcodeConfig, variants, entry, modelOf, model, config,
}
