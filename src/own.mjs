// src/own.mjs —— 跟随 ZCode 自己的登录（~/.zcode/v2/credentials.json）
//
// ZCode 把凭据加密存在本机（AES-256-GCM，enc:v1:<iv>.<tag>.<data>），密钥由
// 机器用户名派生。用户已经在 ZCode 里登录过时，插件直接读它，不弹浏览器；
// ZCode 换了账号、续了会话，插件跟着走。

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createDecipheriv, createHash } from "node:crypto"
import { homedir, userInfo } from "node:os"
import { isAbsolute, join } from "node:path"
import { SITES, ZAI_BASE, BIGMODEL_BASE, first, isTeam, who, uidOf } from "./zcode.mjs"
import { call } from "./zai-call.mjs"
import { keysURL } from "./keys.mjs"

// ---- ZCode's own sign-in ------------------------------------------------------------
// ZCode keeps its sign-in in ~/.zcode/v2/credentials.json, each value
// encrypted (AES-256-GCM, "enc:v1:<iv>.<tag>.<data>") with a key made from
// the machine's user; ~/.zcode/v2/setting.json says whether it is on a
// team's plan. An account signed in "as ZCode" reads them for every
// request, so it follows ZCode's own sign-in, its renewed session and its
// switches between plans, as magpie's built-in did (zcode.go zcodeOwn).
//
// ZCode 3.14 can move its data (数据存储路径, "data storage path"): it copies
// ~/.zcode/v2 to <folder>/.zcode/v2, all but setting.json, and from its next
// start reads credentials.json and runtime/provider from there. The choice
// stays in the home folder's setting.json as dataBaseDir, which ZCode's main
// process reads before anything else (readBootstrapDataBaseDirFromDisk);
// setting.json itself, and the team plan it names, stay in the home folder.

// settingDir is where ZCode keeps setting.json, moved or not.
const settingDir = () => join(homedir(), ".zcode", "v2")

// dataIn is the folder ZCode keeps its .zcode data in: the home folder,
// unless dataBaseDir moved it. A value that isn't an absolute path is
// ignored, as magpie's built-in does (internal/appdir ZCodeDataIn).
function dataIn() {
  const d = readJSON(join(settingDir(), "setting.json"))?.dataBaseDir
  const t = typeof d === "string" ? d.trim() : ""
  return t && isAbsolute(t) ? t : homedir()
}

// zcodeDir is where ZCode keeps credentials.json and runtime/provider.
const zcodeDir = () => join(dataIn(), ".zcode", "v2")

// secret is the key ZCode encrypts its credentials with.
function secret() {
  let seed = process.env.ZCODE_CREDENTIAL_SECRET
  if (!seed) {
    let name = ""
    try {
      name = userInfo().username
    } catch {}
    name = name.slice(name.lastIndexOf("\\") + 1) // DOMAIN\user
    seed = `zcode-credential-fallback:${process.platform}:${homedir()}:${name}`
  }
  return createHash("sha256").update(seed).digest()
}

function decrypt(key, v) {
  if (typeof v !== "string" || !v.startsWith("enc:v1:")) return null
  const parts = v.slice(7).split(".")
  if (parts.length !== 3) return null
  try {
    const [iv, tag, data] = parts.map((p) => Buffer.from(p.replace(/=+$/, ""), "base64url"))
    const d = createDecipheriv("aes-256-gcm", key, iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(data), d.final()]).toString("utf8")
  } catch {
    return null
  }
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// ownTeam is the team plan ZCode switched to, when it did.
function ownTeam(store, key) {
  const set = readJSON(join(settingDir(), "setting.json"))
  if (!set) return null
  const families = set.providerFamilyDomain === "zai" || set.providerFamilyDomain === "bigmodel" ? [set.providerFamilyDomain] : ["zai", "bigmodel"]
  for (const fam of families) {
    let org = ""
    let project = ""
    const sel = set.providerFamilyConnectionSelections?.[fam]
    if (sel) {
      if (sel.kind === "team-coding-plan") [org, project] = [first(sel.organizationId), first(sel.projectId)]
    } else {
      // before providerFamilyConnectionSelections
      const legacy = first(set.modelProviderFamilySelectedKeys?.[fam])
      const pre = `team-plan:builtin:${fam}-coding-plan:`
      if (legacy.startsWith(pre)) {
        const ps = legacy.slice(pre.length).split(":")
        if (ps.length === 3) {
          try {
            ;[org, project] = [decodeURIComponent(ps[1]), decodeURIComponent(ps[2])]
          } catch {}
        }
      }
    }
    if (!org || !project) continue
    const tok = first(decrypt(key, store[`oauth:${fam}:access_token`]))
    if (!tok) continue
    // a stale token ZCode won't use either
    if (fam === "bigmodel" && first(decrypt(key, store.zcodejwttoken)) === tok) continue
    return { site: fam, base: SITES[fam].base, key: "", token: tok, org, project }
  }
  return null
}

// configKey is the coding plan key ZCode's config.json gives its built-in
// coding plan provider, Z.ai's first, as ZCode lists them; ZCode reads it
// as it is, and one written encrypted is read too.
function configKey(key) {
  const providers = readJSON(join(zcodeDir(), "config.json"))?.provider
  if (!providers || typeof providers !== "object") return null
  for (const [ids, base] of [
    [["builtin:zai-coding-plan", "account:zai-individual-coding-plan"], ZAI_BASE],
    [["builtin:bigmodel-coding-plan", "account:bigmodel-individual-coding-plan"], BIGMODEL_BASE],
  ]) {
    for (const id of ids) {
      let k = providers[id]?.options?.apiKey
      if (typeof k !== "string") continue
      k = k.trim()
      if (k.startsWith("enc:")) k = first(decrypt(key, k))
      if (k.includes(".") && !/[\s{$]/.test(k)) return { key: k, base }
    }
  }
  return null
}

// ownLocation is where ZCode 3.16 finds the account's own coding plan key
// when it keeps none: credentials.json's
// project-key-location:v1:<[origin, family, accountId, team, 1, selection]>,
// URI-encoded JSON, holds { organizationId, projectId, apiKeyId } (its
// ProjectAccessTokenClient). ZCode trades that key for a short-lived
// project token each time; here its secret is read (located), as a sign-in
// here reads its own key's. The account's own (team null), of the family
// ZCode is on first, else Z.ai's, as ZCode lists them; one of another
// account the profile names is left alone (meraki7304, #410).
const LOCATION = "project-key-location:v1:"
function ownLocation(store, key) {
  const set = readJSON(join(settingDir(), "setting.json"))
  const fams = set?.providerFamilyDomain === "bigmodel" ? ["bigmodel", "zai"] : ["zai", "bigmodel"]
  const found = []
  for (const [name, v] of Object.entries(store)) {
    if (!name.startsWith(LOCATION)) continue
    let at
    try {
      at = JSON.parse(decodeURIComponent(name.slice(LOCATION.length)))
    } catch {
      continue
    }
    if (!Array.isArray(at) || at[3] !== null || String(at[4]) !== "1" || !fams.includes(at[1])) continue
    let loc
    try {
      loc = JSON.parse(decrypt(key, v) ?? "")
    } catch {}
    const org = first(loc?.organizationId), project = first(loc?.projectId), apiKeyId = first(loc?.apiKeyId)
    if (!org || !project || !apiKeyId) continue
    found.push({ site: at[1], origin: typeof at[0] === "string" ? at[0] : "", account: String(at[2] ?? ""), org, project, apiKeyId })
  }
  for (const site of fams) {
    const token = first(decrypt(key, store[`oauth:${site}:access_token`]))
    if (!token) continue
    let me = ""
    try {
      me = String(JSON.parse(decrypt(key, store[`oauth:${site}:user_info`]) ?? "{}")?.id ?? "")
    } catch {}
    const mine = found.filter((l) => l.site === site && (!me || l.account === me))
    if (!mine.length) continue
    const l = mine[0]
    // the origin ZCode asked, when it is the site's own; else the site's API
    let origin = SITES[site].api
    try {
      const u = new URL(l.origin)
      const h = u.host.toLowerCase()
      if (u.protocol === "https:" && (site === "zai" ? h === "z.ai" || h.endsWith(".z.ai") : h === "bigmodel.cn" || h.endsWith(".bigmodel.cn"))) origin = u.origin
    } catch {}
    return { site, base: SITES[site].base, token, loc: { origin, org: l.org, project: l.project, apiKeyId: l.apiKeyId } }
  }
  return null
}

// located gives a sign-in that has only ZCode's key location (ownLocation)
// its key: the secret of the key it names, read as ZCode lists the
// project's keys (BigModel's token bare, Z.ai's as a Bearer). Nothing is
// made: a location whose key is gone (404) leaves the sign-in keyless, as
// before; any other failure is said. A key read is kept for the token.
const locatedKeys = new Map()
async function located(s) {
  if (!s || s.key || !s.loc || !s.token) return s
  const l = s.loc
  const id = [s.token, l.origin, l.org, l.project, l.apiKeyId].join("\0")
  let got = locatedKeys.get(id)
  if (!got || (got.err && Date.now() - got.at >= 60_000)) {
    const auth = s.site === "zai" ? "Bearer " + s.token : s.token
    try {
      const secret = first((await call("GET", `${keysURL(l.origin, l.org, l.project)}/copy/${encodeURIComponent(l.apiKeyId)}`, { auth }))?.secretKey)
      got = secret ? { key: `${l.apiKeyId}.${secret}` } : { err: new Error("no secret for the key") }
    } catch (e) {
      got = e?.status === 404 ? { key: "" } : { err: e }
    }
    got.at = Date.now()
    locatedKeys.set(id, got)
  }
  if (got.err) throw new Error(`ZCode's ${SITES[s.site].name} coding plan key: ${got.err.message} — sign in to ZCode again`)
  if (got.key) s.key = got.key
  return s
}

// ownSignIn is what ZCode is signed in to now: the account, its coding
// plan key, ZCode's session token (the Start Plan's key) and the team plan
// it is switched to; null when it has none of them.
function ownSignIn() {
  const store = readJSON(join(zcodeDir(), "credentials.json"))
  if (!store || typeof store !== "object") return null
  const key = secret()
  let s = { key: "", base: "" }
  for (const [name, v] of Object.entries(store)) {
    // account-provider:coding-plan:account:zai-individual-coding-plan:account:<uuid>:api-key
    if (!name.includes(":coding-plan:") || !name.endsWith(":api-key")) continue
    const k = decrypt(key, v)
    if (!k || !k.includes(".")) continue
    const base = name.includes(":bigmodel-") ? BIGMODEL_BASE : ZAI_BASE
    // Z.ai's first, as ZCode lists it
    if (!s.key || (base === ZAI_BASE && s.base !== ZAI_BASE)) s = { key: k, base }
  }
  // ZCode 3.15 keeps no plan key in its credentials; the one it uses sits
  // in config.json, the provider's options.apiKey (yetone/magpie#2130)
  if (!s.key) s = configKey(key) || s
  // ZCode 3.16 keeps neither: only where the key is (#410)
  if (!s.key) s = ownLocation(store, key) || s
  const jwt = first(first(decrypt(key, store.zcodejwttoken)).replace(/^Bearer /, ""))
  const team = ownTeam(store, key)
  if (team) s = { ...team, jwt }
  else s = { ...s, jwt, base: s.base || ZAI_BASE, site: s.base === BIGMODEL_BASE ? "bigmodel" : "zai" }
  if (!s.key && !s.jwt && !isTeam(s)) return null
  let info = {}
  for (const name of ["oauth:zai:user_info", "oauth:bigmodel:user_info"]) {
    const v = decrypt(key, store[name])
    if (v && !first(info.email, info.name, info.user_id)) {
      try {
        info = JSON.parse(v)
      } catch {}
    }
  }
  return { ...s, user: who(info), uid: uidOf(info) }
}

export {
  LOCATION, settingDir, dataIn, zcodeDir, secret, decrypt, readJSON,
  ownTeam, configKey, ownLocation, locatedKeys, located, ownSignIn,
}
