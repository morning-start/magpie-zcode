// magpie 插件完整模板
//
// 九项全实现，一项不缺。复制后改 PROVIDER / BASE / 各 TODO 即可。
//
// ⚠ 这份模板是**一个供应商**的形态。如果同一厂商有国内 / 国际两套云、
//   而且必须是 magpie 里的两张卡（两组登录态并存），别在这份上打补丁 ——
//   照 MULTI-PROVIDER.md 的 makePlugin(SITE) 骨架重写，五条铁律照抄。
//
// ═══════════════════════════════════════════════════════════════════════
// 九项清单
// ═══════════════════════════════════════════════════════════════════════
//
//  钩子（magpie 会调）
//   ① config(cfg)                     声明 provider + 静态模型表
//   ② auth.methods[].authorize()      登录
//   ③ auth.refresh(auth, provider)    续期
//   ④ auth.loader(getAuth, provider)  请求接管
//   ⑤ auth.usage(getAuth, provider)   额度 → 卡片进度条
//   ⑥ auth.checkin(getAuth, provider) 签到
//   ⑦ provider.models(provider,{auth}) 每账号目录
//   ⑧ "chat.headers"(input, output)   每请求加头
//
//  数据字段（不是钩子但决定 UI）
//   ⑨ accountId / uid                 卡片显示名 + 同名区分
//      auth.icon / magpie.icon         卡片图标
//      auth.maxConcurrency             并发数
//
// ═══════════════════════════════════════════════════════════════════════
// 三条铁律
// ═══════════════════════════════════════════════════════════════════════
//
// 1. config.models 必须有内容 —— 未登录也要有，否则显示 "0 models"
// 2. authorize() 立刻返回 —— 真正等登录的是 callback()，否则和 magpie 死锁
// 3. refresh 返回的是合并 —— client.auth.set 是整体替换，两者不同
//
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ⚠ 这是一个模板 —— 改完下面三行才有意义
// ═══════════════════════════════════════════════════════════════════════
//
//   PROVIDER        改成厂商自己的 id（agent 用 <id>/<model> 命名）
//   PROVIDER_NAME   供应商名 —— 必须 <中文> <English>，英文照抄厂商官方品牌写法
//                   （插件卡片标题是 package.json 的 name，同一套约定）
//   BASE            上游 API 基址
//
// 然后实现 index.mjs 底部的五个 TODO 函数。
//
// ═══════════════════════════════════════════════════════════════════════

// ── 额度窗口的构造器 ─────────────────────────────────────────────────
// 见 src/quota.mjs：它把「写错不报错、但 GUI 和智能路由会坏」的五类写法变成运行时错误。
// 派生仓库把 src/ 一起带走即可（GUIDE 第 1 步已写明）。
import { usage as buildUsage, usageWindow } from "./src/quota.mjs"
import { createRefreshLock } from "./src/refresh-lock.mjs"
import { createUsageCache } from "./src/usage-cache.mjs"
import { rewriteRefusal } from "./src/status.mjs"
import { uidOf } from "./src/credential.mjs"

// ── 配置 ──────────────────────────────────────────────────────────────

const PROVIDER = "xxx" // ⚠ 改成厂商 id，如 "huawei"
const PROVIDER_NAME = "⚠ 未命名供应商 Unnamed Provider" // ⚠ 改成 <中文> <English>，英文照抄厂商官方写法
const BASE = "https://api.xxx.example/v1"
const SDK = "@ai-sdk/openai-compatible" // 决定 API 形状，见下表
const REFRESH_LEAD_MS = 5 * 60_000

// npm 包 → API 形状
//   @ai-sdk/anthropic        → Anthropic Messages  /messages
//   @ai-sdk/openai           → OpenAI Responses    /responses
//   @ai-sdk/google           → Gemini              /models/<id>:streamGenerateContent
//   @ai-sdk/openai-compatible → Chat completions   /chat/completions

// ── 模型表 ────────────────────────────────────────────────────────────

/** [id, 显示名, 上下文窗口, reasoning efforts] */
// ══════════════════════════════════════════════════════════════════════
// ⚠ context 必须实测，不要凭印象填
// ══════════════════════════════════════════════════════════════════════
//
// 这个数字会被 magpie 转给 agent（DSH 等），决定它什么时候压缩对话。
// 填小了：模型明明能收 100 万，agent 在 12.8 万就开始压缩，浪费容量；
//         更要紧的是路由组按「组内最大」算窗口，一个填小的成员会把整组拉低。
// 填大了：agent 以为还有余量，请求超了上游才报错，用户看到的是
//         「内容太长了」这种莫名其妙的错误。
//
// 实测办法：造一份约 N token 的文本发过去，看 usage.prompt_tokens 和是否 200。
//   别把「最大输出」当成「上下文」—— DeepSeek 系常见 128K 输出 / 1M 上下文，
//   两个数字长得很像，填反了差 8 倍。
//
// 下面是占位值，换成你实测的数字。
const MODELS = [
  ["model-a", "Model A", 200_000, ["low", "high"]],
  ["model-b", "Model B", 1_000_000],
]

/** 静态模型表（未登录 / 拉取失败时兜底） */
function staticModels() {
  const out = {}
  for (const [id, name, context, efforts] of MODELS) {
    out[id] = {
      id,
      name,
      api: { id, url: BASE, npm: SDK },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context, output: 64_000 },
      // config 钩子的静态模型走 modalities；capabilities.input 是 provider.models 路径的字段。
      // 两个都写，避免「只写 capabilities 而 config 路径读不到模态」。
      modalities: { input: ["text"], output: ["text"] },
      capabilities: {
        temperature: true,
        reasoning: Array.isArray(efforts) && efforts.length > 0,
        toolcall: true,
        attachment: false,
        // HOOKS 十一之三：五个模态键必须显式写布尔（省略 image ≠ text）
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true },
      },
      ...(efforts?.length ? { variants: Object.fromEntries(efforts.map((e) => [e, {}])) } : {}),
    }
  }
  return out
}

// ── 插件入口 ──────────────────────────────────────────────────────────

export const XxxAuthPlugin = async (_ctx, _options) => {
  // 同一 refresh_token 的并发续期合并成一次，成功后 60 秒内回放结果。
  // 键必须是凭据身份（refresh_token），不能用 provider id —— 同渠道多账号会串结果。
  const refreshLock = createRefreshLock({ replayMs: 60_000 })
  // 登录补任务与每日签到可能同时触发；同账号共享同一 Promise，不回放成功结果。
  const checkinLock = createRefreshLock({ replayMs: 0 })

  // 额度卡片会被频繁刷新：成功 60 秒、失败 5 秒，同 key 并发合并。
  // key 用凭据身份，不能用 provider id —— 同渠道多账号会串额度。
  const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })

  // _ctx 是宿主给的上下文：{ client, directory, … }。
  // 打日志用 _ctx?.client?.app?.log?.({ service, level, message })。
  //
  // ⚠ 不要往 magpie 的目录里写任何东西（包括它自己的 ~/.cache/magpie/*.json）：
  //   那份文件属于 magpie。插件只读，不写。
  //   卡片标题、「源码」按钮、市场文案的载体是 registry 条目，见 registry-entry.json。

  return {

  // ═══ ① 声明 provider ══════════════════════════════════════════════
  config: async (cfg) => {
    cfg.provider ??= {}
    // ⚠ 用 ??= ，不要覆盖用户在 plugins.json 里配的
    cfg.provider[PROVIDER] ??= {
      name: PROVIDER_NAME,
      npm: SDK,
      api: BASE,
      models: staticModels(), // ⚠ 未登录时也必须有内容
    }
  },

  auth: {
    provider: PROVIDER,

    // ── 数据字段（不是钩子）────────────────────────────────────────
    // ⚠ 图标要写两份，缺一份就有地方显示灰方块：
    //   这里 auth.icon        → 供应商列表那一行、用量概览的卡
    //   package.json 的
    //     magpie.icon        → 插件列表那一行、插件详情页左上角
    //   两处内容一样，直接抄同一份 data URI。见 HOOKS.md「插件自己的图标」。
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMWYyOTM3Ii8+PHRleHQgeD0iNjQiIHk9Ijg0IiBmb250LXNpemU9IjYwIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiM2MGE1ZmEiIHRleHQtYW5jaG9yPSJtaWRkbGUiPkE8L3RleHQ+PC9zdmc+",
    maxConcurrency: 4, // 1-1000
    refreshLead: REFRESH_LEAD_MS,

    // ═══ ② 登录 ═══════════════════════════════════════════════════
    methods: [
      {
        type: "oauth",
        label: `Sign in with ${PROVIDER_NAME}`,

        // 可选：登录前的问题
        prompts: [
          // {
          //   type: "select",
          //   key: "region",
          //   message: "Region",
          //   options: [
          //     { label: "Global", value: "global" },
          //     { label: "China", value: "cn", hint: "xxx.cn" },
          //   ],
          // },
          // {
          //   type: "text",            // 或 "password"（不显示输入）
          //   key: "team",
          //   message: "Team id",
          //   placeholder: "t-...",
          //   when: { key: "region", op: "eq", value: "global" },
          //   validate: (v) => (/^t-/.test(v) ? undefined : "Starts with t-"),
          // },
        ],

        /**
         * ⚠ 必须立刻返回，不能在这里 await 用户完成登录。
         *   否则和 magpie 双向死锁。真正等登录的是 callback()。
         *
         * inputs 只在有 prompts 时传入，否则是 undefined。
         */
        async authorize(inputs) {
          const flow = await startLoginFlow(inputs) // TODO: 启动登录流程
          return {
            url: flow.url, // magpie 打开这个地址
            instructions: "在打开的页面里完成登录，本窗口会自动继续。",
            method: "auto", // "auto" | "code"（code = 用户要粘贴授权码）
            opened: false, // true = 插件自己已经开了页面，magpie 别再开

            async callback(code) {
              // TODO: 等登录完成 / 用 code 换 token
              const t = await flow.result
              if (!t) return { type: "failed", error: "登录超时" }

              return {
                type: "success",
                refresh: t.refresh_token,
                access: t.access_token,
                expires: Date.now() + t.expires_in * 1000,

                // ⚠ 决定卡片显示什么（三级回退：accountId → metadata.email → email）
                accountId: t.email || t.nickname || "",

                // ⚠ 区分同名账号（issue #413）
                uid: t.uid || "",
              }
            },
          }
        },
      },

      // API key 方式（可选）
      // {
      //   type: "api",
      //   label: `${PROVIDER_NAME} API key`,
      //   placeholder: "xxx-...",
      //   // 没有 authorize → 原样保存 { type: "api", key }
      //   // 有 authorize(inputs) → 返回 { type: "success", key }
      // },
    ],

    // ═══ ③ 续期 ═══════════════════════════════════════════════════
    /**
     * 返回值 **合并** 到旧账号上（与 client.auth.set 的整体替换不同）。
     *
     * 运行时机：OAuth 账号的 expires 距现在 < refreshLead 时，
     * 在 loader / models / usage / 请求之前。
     *
     * 串行化：同一 refresh_token 的并发续期会合并成一次（`src/refresh-lock.mjs`），
     * 成功后 60 秒内回放结果 —— 一次性 refresh_token 不会被用两次，
     * 宿主 `auth.refresh` 与请求链路同时触发也不会各花一次旧 token。
     *
     * expires 为 0 或不存在的账号永不续期。
     */
    async refresh(auth, provider) {
      if (!auth?.refresh) return undefined // 没有 refresh_token，不续期

      try {
        // 键 = 凭据身份；同 key 的并发调用共享同一个 in-flight promise
        const t = await refreshLock.run(`${PROVIDER}\n${auth.refresh}`, () => exchangeRefresh(auth.refresh)) // TODO: exchangeRefresh 按厂商实现
        if (!t) return undefined
        return {
          access: t.access_token,
          // 服务端可能轮换 refresh_token，没给就沿用旧的
          refresh: t.refresh_token ?? auth.refresh,
          expires: Date.now() + t.expires_in * 1000,
        }
      } catch (e) {
        // refresh_token 被拒 → 标记账号，不再重试直到重新登录
        if (/invalid_grant|expired|invalid/i.test(String(e?.message))) {
          throw Object.assign(new Error("登录已失效，请重新登录"), { signIn: "expired" })
        }
        // 其它错误 → 30 秒后重试
        throw e
      }
    },

    // ═══ ④ 请求接管 ═══════════════════════════════════════════════
    /**
     * 每个账号跑一次（登录态变化后会重跑）。
     *
     * 返回的字段：
     *   baseURL  请求去哪（优先于模型的 api 和 provider 的 api）
     *   apiKey   按 npm 包自动加头：
     *              @ai-sdk/anthropic → x-api-key
     *              @ai-sdk/google    → x-goog-api-key
     *              其它              → Authorization: Bearer
     *   headers  每个请求都加
     *   fetch    真正的请求函数
     *
     * 请求头的设置顺序（后者覆盖前者）：
     *   sdkHeaders(apiKey) → loader.headers → gateway 的 → chat.headers 的
     */
    async loader(getAuth, provider) {
      const auth = await getAuth()
      if (!auth || auth.type !== "oauth") return {}

      return {
        baseURL: BASE,
        apiKey: auth.access, // 或空字符串，自己在 fetch 里加头
        headers: {
          "user-agent": "XxxClient/1.0.0", // ⚠ 很多厂商硬校验这个
        },

        async fetch(input, init) {
          // ⚠ 每次重新读 auth —— 可能已被 refresh 更新
          const fresh = await getAuth()
          if (!fresh) throw new Error(`${PROVIDER_NAME} 未登录`)

          const req = input instanceof Request ? input : null
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : req?.url ?? ""

          // 合并请求头：先取进来的，再被我们的覆盖
          const incoming = new Headers(init?.headers ?? req?.headers ?? {})
          const headers = {
            authorization: `Bearer ${fresh.access}`,
            "content-type": "application/json",
          }
          for (const [k, v] of incoming) {
            const lower = k.toLowerCase()
            // 这几个必须由我们决定
            if (["authorization", "x-api-key", "x-goog-api-key", "host", "content-length", "user-agent"].includes(lower)) continue
            headers[k] = v
          }

          let body = init?.body
          if (body === undefined && req) body = await req.text()

          // TODO: 按需改写 body（比如加 stream_options）

          const res = await fetch(url, {
            method: init?.method ?? "POST",
            headers,
            body,
            signal: init?.signal ?? req?.signal ?? AbortSignal.timeout(300_000),
          })

          // 模型不存在 → 返回 404，magpie 只搁置这个模型
          // if (res.status === 404) { ... }

          // 登录被拒 → 401 或响应头 X-Magpie-Sign-In: expired
          // 这个 401 是别的事 → X-Magpie-Sign-In: kept
          // 已续期 → X-Magpie-Sign-In: renewed

          // 只分类 400/422 的明确余额/渠道/模型/限流错误；SSE 与其它响应原样返回。
          return rewriteRefusal(res)
        },
      }
    },

    // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
    /**
     * 决定卡片上的进度条。
     *
     * windows[].name     → 进度条上方的标签
     * windows[].used     → 已用百分比（0-100，超额 >100）
     * windows[].display  → 数字显示，如 "2,131.63 / 3,400 积分"
     * windows[].amount   → 已用
     * windows[].limit    → 总量
     * windows[].unit     → 单位
     * windows[].resetsAt → 重置时间
     * windows[].aside    → true 表示用光不停账号（附加额度）
     *
     * 只给 used 不给 display/amount/limit → 只有光秃秃的进度条。
     */
    async usage(getAuth, provider) {
      const auth = await getAuth()
      if (!auth) return { error: "未登录", windows: [] }

      // 只缓存有凭据身份的账号；匿名调用本来就不会打到上游。
      const usageKey = uidOf(auth)
      if (!usageKey) return { error: "未登录", windows: [] }

      let u
      try {
        u = await usageCache.readSWR(String(usageKey), () => fetchUsage(auth), { timeoutMs: 10_000 }) // TODO
      } catch (e) {
        // 上游失败 → 让卡片显示原因。抛出去 magpie 只会记成「读取失败」，用户看不到原因。
        return { error: String(e?.message ?? e), windows: [] }
      }

      // ⚠ 下面的窗口由 src/quota.mjs 的构造器生成 —— 它在**写法错**时直接抛 QuotaShapeError：
      //   写错的窗口不会让插件崩，只会让 GUI 显示「剩余额度未知」、让这个号在智能路由里
      //   被当成不存在，而日志里什么都没有。把这几类错变成运行时错误，是这个构造器唯一的用途。
      return buildUsage({
        plan: u.plan,       // 卡片上的 "Free plan" 标签
        user: u.user,       // 厂商那边这个账号的名字
        until: u.until,     // 套餐到期
        renew: "auto",      // "auto" | "off"
        balance: u.balance, // "$12.40"

        windows: [
          // ① 占比型：used 必填，漏了按 0% = 满额算，空号反而排到路由队首
          usageWindow({
            name: "5 小时",
            used: u.percentUsed,  // 0-100，超额可 >100
            resetsAt: u.resetsAt, // ISO / 秒 / 毫秒都行，构造器统一转 ISO
            span: 18000,          // 窗口长度（秒）
          }),

          // ② 数量型（有上限）：amount / limit 必须成对，limit > 0
          // usageWindow({ name: "积分", used: 37, amount: 370, limit: 1000, unit: "积分", resetsAt: u.resetsAt }),

          // ③ 钱包型（只有余额、没有上限）：给 balance，**不要**给 used
          // usageWindow({ name: "积分", balance: 6291, unit: "积分" }),

          // ④ 附加额度（用光也不停账号）：aside: true，**不要**给 amount/limit
          // usageWindow({ name: "赠送", used: 0, aside: true, display: "5,500" }),

          // ⑤ 号被蹬空：给 used: 100，别「什么都不画」—— 不画 = 没有参与路由的窗口 = 它继续排前面
          // usageWindow({ name: "积分", used: 100, display: "已耗尽" }),
        ],

        // 可选：还能用几次重置
        // resets: { count: 2, fiveHour: 1, weekly: 1 },

        // 可选：这次读取对登录态意味着什么
        // signIn: "expired" | "kept" | "renewed",
      })
    },

    // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
    /**
     * 调用规则（magpie 契约原文）：
     *   - 按 **北京时间**，每账号每天一次
     *   - 当天失败后还会再调
     *   - 抛异常 = 失败
     *   - 在账号的 scope 里，它刷新的 token 会存到该账号
     *
     * outcome 六种：
     *   "claimed"     刚签到成功
     *   "done"        今天已经签过了
     *   "ineligible"  这个账号不能参加
     *   "inactive"    没有签到活动
     *   "captcha"     厂商要验证码 —— 让用户去官方 App 手动签，永不解
     *   "failed"      失败
     */
    async checkin(getAuth, provider) {
      const auth = await getAuth()
      if (!auth) return { outcome: "failed", message: "未登录" }

      const account = uidOf(auth)
      if (!account) return { outcome: "failed", message: "未登录" }
      const key = `${provider?.id || PROVIDER}\n${account}`
      return checkinLock.run(key, async () => {
        try {
          const r = await doCheckin(auth) // TODO

          // 厂商没有签到功能
          if (!r.supported) {
            return { outcome: "inactive", message: `${PROVIDER_NAME} 无每日签到` }
          }

          // 今天已经签过
          if (r.alreadyToday) {
            return { outcome: "done", message: "今天已签到", streak: r.streakDays }
          }

          // 厂商要验证码 —— 永远不要去解
          if (r.needsCaptcha) {
            return {
              outcome: "captcha",
              message: "厂商要求验证码，请到官方 App 里手动签到",
            }
          }

          // 刚签到成功
          return {
            outcome: "claimed",
            credit: r.credit,
            streak: r.streakDays,
            message: r.message,
          }
        } catch (e) {
          return { outcome: "failed", message: String(e?.message ?? e) }
        }
      })
    },
  },

  // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
  /**
   * magpie 为每个账号调一次，在该账号的 scope 和代理里。
   *
   * provider.models 是「上次的列表」（models.dev + config 钩子给的）。
   *
   * 失败回退的三种方式：
   *   1. fetch 失败后原样返回 provider.models
   *   2. 抛异常
   *   3. 返回自己的列表并设 list[Symbol.for("magpie.fellBack")] = true
   *
   * ⚠ 局部成功时**不要**标 fellBack —— 那样 magpie 会整份丢弃。
   *
   * 登录态失效 → 抛带 signIn: "expired" 的错误。
   */
  provider: {
    id: PROVIDER,

    async models(provider, { auth } = {}) {
      const fallback = staticModels()
      if (!auth || auth.type !== "oauth") return fallback

      try {
        const live = await fetchLiveModels(auth) // TODO
        if (!live.length) return fallback

        const out = {}
        for (const m of live) {
          // 保留静态表里的配置，只更新 id/name/limit
          const base = fallback[m.id] ?? Object.values(fallback)[0]
          out[m.id] = { ...base, id: m.id, name: m.name ?? m.id }
        }
        return out
      } catch (e) {
        // 登录被拒 → 标记账号
        if (/401|unauthorized|expired/i.test(String(e?.message))) {
          throw Object.assign(new Error("登录已失效"), { signIn: "expired" })
        }
        return fallback
      }
    },
  },

  // ═══ ⑧ 每请求加头 ═════════════════════════════════════════════
  /**
   * input.sessionID 是 magpie 的会话 id，同一会话多轮不变。
   * 可以用来做服务端的 session / cache 头。
   */
  "chat.headers": async (input, output) => {
    const id = input?.model?.providerID ?? input?.provider?.info?.id
    if (id !== PROVIDER || !input?.sessionID) return
    output.headers["x-xxx-session"] = String(input.sessionID).slice(0, 128)
  },
  }
}

// ── 以下是 TODO，按具体厂商实现 ─────────────────────────────────────

async function startLoginFlow(inputs) {
  throw new Error("TODO: 实现登录流程")
}

async function exchangeRefresh(refreshToken) {
  throw new Error("TODO: 实现 token 刷新")
}

async function fetchUsage(auth) {
  throw new Error("TODO: 实现额度查询")
}

async function doCheckin(auth) {
  throw new Error("TODO: 实现签到")
}

async function fetchLiveModels(auth) {
  throw new Error("TODO: 实现模型目录拉取")
}

// 供测试引用（⚠ 入口文件不要导出 helper 函数，否则会被当插件调用）
export const _internal = {
  PROVIDER,
  BASE,
  staticModels,
  MODELS,
}
