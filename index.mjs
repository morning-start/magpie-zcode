// ZCode（zcode.z.ai）的 GLM Coding Plan —— magpie provider 插件
//
// 这里只做「装配」：九项钩子各接一个实现，实现在 src/ 里。
//
//  ① config(cfg)                        声明 provider + 静态模型表
//  ② auth.methods[].authorize()          登录（Z.ai / BigModel / 团队席位 / ZCode App）
//  ③ auth.refresh(auth, provider)        续期（ZCode 的 Start Plan token 不能续，只能重登）
//  ④ auth.loader(getAuth, provider)      请求接管（src/loader.mjs）
//  ⑤ auth.usage(getAuth, provider)       额度卡片（src/allowance.mjs）
//  ⑥ auth.checkin(getAuth, provider)     每日领取赠送计划（src/claim.mjs）
//  ⑦ provider.models(provider, {auth})   每账号的模型目录（src/catalog.mjs）
//  ⑧ "chat.headers"(input, output)       每请求加 x-session-id
//
// 数据字段：accountId / uid（卡片显示名 + 同名区分）、icon、maxConcurrency、maxAccounts。
//
// 三条铁律：config.models 必须有内容（未登录也有）；authorize() 立刻返回；
// refresh 返回的是合并结果。
//
// ⚠ 入口文件只导出插件函数和 _internal（测试用）—— 别的导出会被当成插件调用。

import { PROVIDER, PROVIDER_NAME, FREE_FIRST, MODELS, START_MODELS, START_BASE, ZAI_BASE, SITES, siteOf, isTeam, keyDevice } from "./src/zcode.mjs"
import { entry, model, modelsOf, planID, zcodeConfig, config, clientConfigs, resetClientConfigs } from "./src/catalog.mjs"
import { stateOf } from "./src/session.mjs"
import { located, ownSignIn } from "./src/own.mjs"
import { plansOf, routes } from "./src/plan.mjs"
import { startPlan, giftNames, giftID, giftReadable, giftSignIn, giftOf, blocked, sidelined, giftServes } from "./src/gift.mjs"
import { teamKey, teamKeys } from "./src/keys.mjs"
import { codingUsage, dualUsage, startUsage, teamUsage, limitWindows, termOf } from "./src/allowance.mjs"
import { claimDaily, claimHint, resetRateWait, holdKey, rateWait } from "./src/claim.mjs"
import { authorize, asZCode } from "./src/signin.mjs"
import { createLoader } from "./src/loader.mjs"
import { DEFAULT_CONCURRENCY, DEFAULT_ACCOUNTS, busyHold, busyCap, busyHeld, startGate, BUSY_N, BUSY_WINDOW, BUSY_HOLD, BUSY_WAITS, busy } from "./src/concurrency.mjs"
import { edge, EDGE_HOLD, sessionOf, dress, queryOf, marked } from "./src/start.mjs"
import { modelOf } from "./src/catalog.mjs"
import { kept, spentUp } from "./src/answer.mjs"
import PROMPT from "./src/prompt.mjs"

/**
 * 插件入口。magpie 对每个账号调一次。
 *
 * @param {{client?: any, magpie?: any}} [ctx] 宿主上下文
 * @param {any} [options] 插件自己的选项（Plugins › Options 的 JSON）
 */
export async function ZCodeAuthPlugin({ client, magpie } = {}, options = {}) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "zcode-auth", level: "error", message } })
    } catch {}
  }
  // freeFirst reads the option from the provider config's options first,
  // and from the plugin's own (magpie's Plugins › Options) when the
  // provider carries no freeFirst of its own. It is on unless one of them
  // says false: a gift ZCode hands out (each weekend, sgfvdsg86265 on X)
  // lapses unused behind an agent that asks the plain model, and every
  // failure of the gift is answered from the plan. magpie's switch in
  // the provider's editor (FREE_FIRST, auth.options below) turns it off
  // too; it is on by default, so a JSON freeFirst: false a user wrote
  // before the switch existed keeps it off. A key magpie doesn't report
  // (an older magpie, OpenCode) leaves it as the JSON says.
  const freeFirst = (providerOptions) =>
    magpie?.options?.(PROVIDER)?.[FREE_FIRST] !== false &&
    (providerOptions?.freeFirst !== undefined ? providerOptions.freeFirst !== false : options?.freeFirst !== false)
  const oauth = (site) => ({
    type: "oauth",
    label: `ZCode: ${SITES[site].name}${site === "bigmodel" ? " (智谱)" : ""} GLM Coding Plan`,
    authorize: () => authorize(site, log),
  })
  return {
    // the agent's session, which magpie tells the plugins here and not
    // in the request, goes on as x-session-id (sessionOf)
    "chat.headers": async (input, output) => {
      const provider = input?.model?.providerID ?? input?.provider?.info?.id
      if (provider !== PROVIDER) return
      const id = input?.sessionID
      if (typeof id === "string" && id.trim()) output.headers["x-session-id"] = sessionOf(id)
    },
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/anthropic",
        api: ZAI_BASE + "/v1",
        ...was,
        models: { ...Object.fromEntries(MODELS.map((m) => [m.id, entry(m)])), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER,
      // the account's plan's models, as ZCode's config lists them now
      async models(provider, { auth } = {}) {
        // a ZCode 3.16 sign-in holds only where its key is: read the key
        // first, as a request does, or plansOf takes the keyless sign-in
        // for a Start Plan one and lists that plan's models (#439). A key
        // that can't be read throws, and magpie keeps the list it had.
        const s = await located(stateOf(auth))
        if (!s) return provider.models
        const { start, gift: known } = await plansOf(s).catch(() => ({ start: false, gift: null }))
        const gift = start ? await startPlan(s.jwt, s.device).catch(() => null) : known
        const base = start ? START_BASE : s.base
        const cfg = await zcodeConfig().catch(() => null)
        let ms = modelsOf(cfg, planID(base))
        // ZCode's config can't be had: its table stands in, and magpie keeps
        // the list it was told last, as the built-in keeps the one it fetched last
        const fell = !ms.length
        if (fell) ms = start ? START_MODELS : MODELS
        // a gift-only account serves what its balance names, as ZCode
        // offers it (resolveStartPlanBalanceAvailability): the Start
        // Plan's config models the balance lacks would only be refused
        // (young02036). A balance naming none leaves the config's list.
        if (start && giftNames(gift).length) ms = ms.filter((m) => giftNames(gift).some((x) => x.toLowerCase() === m.id.toLowerCase()))
        const url = s.base + "/v1"
        const out = Object.fromEntries(ms.map((m) => [m.id, model(m, url)]))
        const details = [...ms, ...modelsOf(cfg, planID(START_BASE)), ...modelsOf(cfg, planID(ZAI_BASE)), ...MODELS]
        const about = (raw) => details.find((m) => m.id.toLowerCase() === raw.toLowerCase()) ?? { efforts: [] }
        const has = new Set(Object.keys(out).map((id) => id.toLowerCase()))
        for (const raw of giftNames(gift)) {
          // a gift-only account's models are its gift's, by their own
          // names, as ZCode lists them (its Start Plan's GLM-5.3, which the
          // plan's config leaves out): every request of it goes to the gift
          // anyway, and the card counts them by that name too (#1261)
          if (start && !has.has(raw.toLowerCase())) {
            const plain = about(raw).id ?? raw
            has.add(raw.toLowerCase())
            out[plain] = model({ ...about(raw), id: plain }, url)
          }
          const id = giftID(raw)
          if (out[id]) continue
          out[id] = model({ ...about(raw), id }, url)
        }
        // a fallback tells magpie to keep the list it was told last, which
        // predates the gift read just made: an account whose gift lists
        // trial entries is told this list, so ZCode's config out of reach
        // (a remote box that can't get its CDN) never hides them
        if (fell && !giftNames(gift).length) out[Symbol.for("magpie.fellBack")] = true
        return out
      },
    },
    auth: {
      provider: PROVIDER,
      // a plan serves one account a few requests at a time: magpie's own
      // field, so its queue spaces what the agents ask for before the vendor
      // sees it. For the coding plan this is a default, not a cap the plugin
      // enforces — its cap follows its tier (Max > Pro > Lite) and the time
      // of day, and a user who knows theirs can raise this on the account.
      // The Start Plan has the plugin's own gate below it (startGate)
      maxConcurrency: DEFAULT_CONCURRENCY,
      // how many accounts take requests at once, the others in reserve
      // (DEFAULT_ACCOUNTS); a magpie that doesn't read it uses them all
      maxAccounts: DEFAULT_ACCOUNTS,
      // ⚠ 图标要写两份，缺一份就有地方显示灰方块：这里给供应商列表和用量卡，
      // package.json 的 magpie.icon 给插件列表和详情页。两处内容一样。
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMTQxNTFhIi8+PHRleHQgeD0iNjQiIHk9Ijg2IiBmb250LXNpemU9IjcyIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiM0ZDZmZjciIHRleHQtYW5jaG9yPSJtaWRkbGUiPlo8L3RleHQ+PC9zdmc+",
      // magpie's own switches (OpenCode never reads auth.options), read at
      // each request through input.magpie
      options: [
        {
          key: FREE_FIRST,
          label: "Free quota first",
          description: "When on, the plain GLM models spend ZCode's free Start Plan quota (the -Trial entries' quota) before the GLM Coding Plan, and go to the plan when it is spent or refused. Off: only the -Trial entries use it. freeFirst: false in the options JSON turns it off too.",
          labels: { zh: "优先用免费额度", "zh-TW": "優先用免費額度", ja: "無料枠を優先", de: "Gratis-Kontingent zuerst" },
          descriptions: {
            zh: "开启后，普通的 GLM 模型先用 ZCode 的免费 Start Plan 额度（即 -Trial 条目的额度），用完或被拒时再用 GLM Coding Plan。关闭后只有 -Trial 条目会用它。选项 JSON 里的 freeFirst: false 也会关闭它。",
            "zh-TW": "開啟後，一般的 GLM 模型會先用 ZCode 的免費 Start Plan 額度（即 -Trial 項目的額度），用完或被拒絕時再用 GLM Coding Plan。關閉後只有 -Trial 項目會用它。選項 JSON 裡的 freeFirst: false 也會關閉它。",
            ja: "オンにすると、通常の GLM モデルは GLM Coding Plan より先に ZCode の無料 Start Plan 枠（-Trial 項目の枠）を使い、使い切るか拒否されるとプランに戻ります。オフでは -Trial 項目だけが使います。オプション JSON の freeFirst: false でもオフになります。",
            de: "Ist dies an, nutzen die normalen GLM-Modelle zuerst ZCodes freies Start-Plan-Kontingent (das der -Trial-Einträge) und erst danach den GLM Coding Plan. Aus: nur die -Trial-Einträge nutzen es. freeFirst: false im Optionen-JSON schaltet es auch aus.",
          },
          default: true,
        },
      ],
      // 请求接管全在 src/loader.mjs：它把「这次请求走哪条路、长什么样、
      // 什么时候算结束」三件事放在一起
      loader: createLoader({ client, magpie, options }),
      // the plan's allowance, as magpie's built-in showed it. Each read
      // keeps the sign-in (signIn): the built-in's marked no account lapsed,
      // its expired Start Plan sign-in among them, and cleared none
      async usage(getAuth, provider) {
        const auth = await getAuth()
        const s = stateOf(auth)
        if (!s) return { error: "not signed in", signIn: "kept" }
        try {
          await located(s)
        } catch (e) {
          return { error: e.message, signIn: "kept" }
        }
        // every card starts from the plan the sign-in saved, as magpie's
        // built-in did: a reply without a level, a team detail that
        // failed or an error keeps it
        const saved = (out) => {
          const plan = s.plan || auth?.plan
          if (plan && !out.plan) out.plan = plan
          // MCP reads as a footnote: its window goes last on the card
          if (Array.isArray(out.windows) && out.windows.some((w) => w.name === "MCP · Month"))
            out.windows = [...out.windows.filter((w) => w.name !== "MCP · Month"), ...out.windows.filter((w) => w.name === "MCP · Month")]
          out.signIn = "kept"
          return out
        }
        try {
          // a card read is a fresh read: the route is read again with it,
          // so a plan bought, a gift claimed or a plan lapsed reaches the
          // requests when the card shows it, not ten minutes later (#379)
          routes.delete(s.key + "\0" + s.jwt)
          const { start, gift } = await plansOf(s)
          let card
          if (isTeam(s)) {
            let key = s.key
            if (!key) {
              key = await teamKey(s)
              if (auth?.type === "oauth") {
                const next = { ...auth, refresh: JSON.stringify({ ...s, key }), access: key }
                await client?.auth?.set?.({ path: { id: provider?.id ?? PROVIDER }, body: next }).catch?.(() => {})
              }
            }
            const team = await teamUsage(s, key)
            card = saved(gift || giftReadable(s) ? await dualUsage(s, team) : team)
          } else card = saved(start ? await startUsage(s) : gift || giftReadable(s) ? await dualUsage(s) : await codingUsage(s))
          // a gift plan ZCode holds for the account but has not put on it:
          // named on the card, claimed in the ZCode app (its claim needs
          // the app's captcha attestation, see claimHint). A card that is
          // an error keeps its error and asks nothing
          if (!card.error) {
            const hint = await claimHint(s)
            if (hint) card.windows = [...(card.windows ?? []), hint]
            // a key, or a ZCode session that ran out: no gift read, so no
            // -Trial models, said on the card rather than left out unsaid
            const need = start ? null : giftSignIn(s, auth?.type === "api")
            if (need) card.windows = [...(card.windows ?? []), need]
          }
          return card
        } catch (e) {
          return saved({ error: e?.message ?? String(e) })
        }
      },
      // the daily claim of ZCode's gift plans (#503): magpie runs it once a
      // day per account while Settings' Daily check-in has ZCode on (off
      // until the user turns it on), and its Check in now button asks
      // right away. See claimDaily.
      async checkin(getAuth) {
        try {
          return await claimDaily(stateOf(await getAuth()))
        } catch (e) {
          return { outcome: "failed", message: e?.message ?? String(e) }
        }
      },
      methods: [
        oauth("zai"),
        oauth("bigmodel"),
        // a team's plan beside the account's own (#285): the sign-ins above
        // take the account's own plan when it has one
        {
          type: "oauth",
          label: "ZCode: a team's GLM Coding Plan",
          prompts: [
            {
              type: "select",
              key: "site",
              message: "Where is the team's plan?",
              options: [
                { label: "Z.ai", value: "zai", hint: "z.ai" },
                { label: "BigModel (智谱)", value: "bigmodel", hint: "bigmodel.cn" },
              ],
            },
          ],
          authorize: (inputs) => authorize(inputs?.site === "bigmodel" ? "bigmodel" : "zai", log, true),
        },
        { type: "oauth", label: "ZCode app's sign-in", authorize: async () => asZCode() },
        {
          type: "api",
          label: "GLM Coding Plan API key",
          prompts: [
            {
              type: "select",
              key: "site",
              message: "Where is the key from?",
              options: [
                { label: "Z.ai", value: "zai", hint: "api.z.ai" },
                { label: "BigModel (智谱)", value: "bigmodel", hint: "open.bigmodel.cn" },
              ],
            },
          ],
        },
      ],
    },
  }
}

// 供测试引用（⚠ 入口文件只导出插件函数和这个对象 —— 别的导出会被当成插件调用）
export const _internal = {
  // 身份与常量
  PROVIDER, PROVIDER_NAME, FREE_FIRST, MODELS, START_MODELS, START_BASE, ZAI_BASE, SITES,
  // 状态与缓存（测试要清、要注入）
  routes, blocked, sidelined, teamKeys, rateWait, startGate, busyHold, edge,
  // 常量
  EDGE_HOLD, BUSY_HOLD, BUSY_N, BUSY_WINDOW, BUSY_WAITS, DEFAULT_CONCURRENCY, DEFAULT_ACCOUNTS,
  // 读配置 / 注入配置
  config, zcodeConfig, clientConfigs, resetClientConfigs,
  // 纯函数与单步实现
  entry, modelOf, limitWindows, termOf, keyDevice, sessionOf, queryOf, dress, marked, PROMPT,
  stateOf, located, ownSignIn, plansOf, startPlan, giftID, giftNames, giftOf, giftServes,
  giftReadable, startUsage, dualUsage, codingUsage, teamUsage, claimHint, claimDaily,
  spentUp, busy, busyCap, busyHeld, holdKey, resetRateWait, authorize, asZCode, isTeam, siteOf,
}
