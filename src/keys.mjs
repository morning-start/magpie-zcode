// src/keys.mjs —— 把「账号的登录态」换成「计划自己的 API key」
//
// ZCode 不在账号上存 key，而是用账号的登录态去默认项目里找/建一个叫
// zcode-api-key 的 key，再读它的 secret（<id>.<secret>）。团队席位用
// zcode-team-api-key（keyType 2）。

import { SITES, first } from "./zcode.mjs"
import { call } from "./zai-call.mjs"

// ---- keys ------------------------------------------------------------------------

function teamHeaders(base, org, project) {
  return {
    "Bigmodel-Organization": org,
    "Bigmodel-Project": project,
    "Set-Language": base.includes("bigmodel.cn") ? "zh" : "en",
    "Accept-Language": "en-US,en",
  }
}

const keysURL = (root, org, project) =>
  `${root}/api/biz/v1/organization/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/api_keys`

// projectKey finds the project's key named want.name (of want.keyType, when
// given), makes it when it isn't there and reads its secret: `<id>.<secret>`.
async function projectKey(site, keys, auth, headers, want) {
  const name = SITES[site].name
  let list
  try {
    list = (await call("GET", keys, { auth, headers })) ?? []
  } catch (e) {
    throw new Error(`${name} API keys: ${e.message}`)
  }
  const typed = "keyType" in want
  let id = ""
  for (const k of Array.isArray(list) ? list : []) {
    if (k.name === want.name && (!typed || String(k.keyType) === String(want.keyType)) && first(k.apiKey)) id = first(k.apiKey)
  }
  if (!id) {
    try {
      id = first((await call("POST", keys, { auth, headers, body: want }))?.apiKey)
    } catch (e) {
      throw new Error(`${name} API key: ${e.message}`)
    }
  }
  let secret = ""
  if (id) {
    try {
      secret = first((await call("GET", `${keys}/copy/${encodeURIComponent(id)}`, { auth, headers }))?.secretKey)
    } catch (e) {
      throw new Error(`${name} API key: ${e.message}`)
    }
  }
  if (id && !secret && typed) return id // a team's key with no secret goes as it is
  if (!id || !secret) throw new Error(`${name} gave no API key`)
  return `${id}.${secret}`
}

// teamKey is a team seat's key when the sign-in kept none.
const teamKeys = new Map()
async function teamKey(s) {
  if (s.key) return s.key
  const id = [s.token, s.org, s.project].join("\0")
  const got = teamKeys.get(id)
  if (got && (!got.err || Date.now() - got.at < 60_000)) {
    if (got.err) throw got.err
    return got.key
  }
  const site = s.base.includes("bigmodel.cn") ? "bigmodel" : "zai"
  try {
    const key = await projectKey(site, keysURL(SITES[site].api, s.org, s.project), s.token, teamHeaders(s.base, s.org, s.project), { name: "zcode-team-api-key", keyType: 2 })
    teamKeys.set(id, { key, at: Date.now() })
    return key
  } catch (e) {
    const err = new Error(`ZCode's team plan: ${e.message} — sign in to ZCode again`)
    teamKeys.set(id, { err, at: Date.now() })
    throw err
  }
}

export { teamHeaders, keysURL, projectKey, teamKeys, teamKey }
