# 实现细节

> 用户门面在 [README.md](../README.md)。这份给要改代码的人：协议怎么反出来的、为什么这么写、
> 哪些地方少写一个字段会静默出错。

## 请求怎么路由

| 账号状态 | 请求去哪 | 说明 |
|---|---|---|
| 有 Coding Plan（个人） | `api.z.ai/api/anthropic` 或 `open.bigmodel.cn/api/anthropic` | 用 `zcode-api-key` |
| 只有团队席位 | 团队项目对应的计划 | 用 `zcode-team-api-key`，首次读取后会存回账号 |
| 两者都没有，有 Start Plan | `zcode.z.ai/api/v1/zcode-plan/anthropic` | 请求按 ZCode 的形状整形（见下） |
| 有 Coding Plan，也有赠送额度 | 默认：普通模型**先**花赠送额度（`-Trial` 条目），被拒回落到计划 | 「优先用免费额度」开关，`freeFirst: false` 可关 |

Start Plan 只服务「看起来像 ZCode 自己发的」请求，所以插件把它改写成 ZCode 的样子：

- ZCode 自己的请求头（`X-Title: Z Code@electron`、`X-ZCode-App-Version`、`X-Platform`、
  `X-Os-Category`、`X-Release-Channel` 等）；
- 三段缓存 system block，agent 自己的 system 文本接在第三段末尾（第四段会被 405/3012 拒）；
- 当天日期作为一个 `<system-reminder>` 用户轮次放在最前；
- `metadata.user_id` 带登录态的 device id（计划端点按它认机器、保 prompt 缓存）；
- 每次用户轮次一个 `x-query-id`（UUID，同一轮的 tool 结果复用）；
- 每个请求带 `x-session-id`（Agent 的会话 id 是 UUID 就用它，否则按它算一个稳定的 UUID）。

Coding Plan 的请求基本原样转发，只补 `metadata.user_id` 与 `x-session-id`。

Claude Code 的 `ToolSearch` 会以 `ToolSearchTool` 发出去（否则计划端点只给模型看这一个工具），
模型对它的调用再改回 `ToolSearch`。`-Trial` 条目就是赠送额度的模型名。

## 并发与退避

- **Start Plan**：每账号同时最多 3 个在飞请求（`startGate`，进程内存），多的排队等；
  等到 120 秒还没轮上就回 429（带 `Retry-After`），magpie 会换账号而不是空转。
- **被拒**：ZCode 的 3008/3009/3010（「当前系统繁忙」）是并发上限，不是计划用尽 ——
  按 ZCode 自己的客户端 1s、2s 再问；再不行把 429 交回 magpie。
- **防火墙**：一分钟内 5 次「重问之后还是 3008」说明这台机器把地址打满了，
  插件让整个进程暂停 3 分钟（只暂停 Start Plan 的模型请求，额度读取和签到照常），
  免得 IP 被 Aliyun 防火墙 405 一两个小时。
- **Coding Plan 不设插件自己的闸**：它的上限跟套餐档位（Max > Pro > Lite）和时段有关，
  写死一个数字会把 Max 账号压到 Lite 的水平。这里用 magpie 的 `maxConcurrency: 3` 排队。

## 额度卡片

`auth.usage` 返回：

- **Coding Plan**：5 小时 / 周的百分比与「已用 / 总量」，套餐名（`GLM Coding Pro` 之类）、
  到期与是否自动续费、还能用几次重置（个人 / 团队）；
- **团队席位**：团队的 5 小时 / 周窗口、计划名与结束时间；
- **Start Plan**：每个 live 计划下每个 bucket 一条窗口，名字是 ZCode 的 `show_name`
  （多个计划时后面缀上计划名），已花的 bucket 标 `aside`（只上卡片、不参与路由）；
  还没开始的计划单独一行（`aside` + 计划名与开始时间）；
- **脚注**：MCP 月调用数（`aside`，排最后）；key 没有计划、或 ZCode 会话过期时，
  卡上会说明为什么没有 `-Trial` 模型；营销 feed 里挂着没领的赠送计划也会列一行。

所有时间都转成 ISO；`aside` 的窗口不给 `amount`/`limit`（否则会算出「永远剩余 100%」的假占比）。

## 登录方式

- **ZCode: Z.ai GLM Coding Plan** / **ZCode: BigModel (智谱) GLM Coding Plan**
  - zcode.z.ai 打开一个登录流程，浏览器里签 Z.ai 或智谱，插件轮询到完成为止 —— 不需要粘贴任何东西。
  - 拿到登录态后，它在账号的默认项目里找名为 `zcode-api-key` 的 key，没有就建一个，
    再读它的 secret（`<id>.<secret>`），请求发到 `api.z.ai/api/anthropic` 或
    `open.bigmodel.cn/api/anthropic`。
  - 账号自己没有计划时，它去找团队计划里的席位，用那个团队项目的 `zcode-team-api-key`。
  - 两者都没有，就用 ZCode 的免费 **Start Plan**（zcode.z.ai 用 ZCode 自己的会话 token 服务）。
  - Start Plan 的 token 不能续期，过期就重新登录。
- **ZCode: a team's GLM Coding Plan** —— 把「团队席位」单独当成一个账号（ZCode 的计划选择器里
  团队计划和个人计划是并列的两项）。
- **ZCode app's sign-in** —— 跟着本机 ZCode App 的登录态走：读
  `~/.zcode/v2/credentials.json`（AES-256-GCM 加密，密钥由机器用户名派生），
  包括 3.14 的「数据存储路径」、3.15 的 `config.json` 密钥、3.16 的 `project-key-location`。
  ZCode 换账号、续会话、切计划，插件跟着变；ZCode 退出登录就报「登录已失效」。
- **GLM Coding Plan API key** —— 直接粘 key（`<id>.<secret>`），选 Z.ai 还是智谱。

## 模型目录

ZCode 的模型表在它自己的 provider 配置里，插件读 revision 更新的那份：

- 在线：`/api/v1/client/configs` 给出的 `builtin_provider_config_json` 地址；
- 离线：已安装 ZCode 的 `~/.zcode/v2/runtime/provider/**/zcode-builtin.json`
  （macOS 另含 `/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json`）。

两份都读不到时用静态表（`GLM-5.3` / `GLM-5.3-Flash` / `GLM-5.2` / `GLM-5-Turbo`），
并给 magpie 打 `magpie.fellBack` 标记让它保留上次的列表。
赠送额度服务的模型以 `<模型>-Trial` 出现，`-Trial` 条目在选择器里就是「用赠送额度」。

## 领取链路取证

- `billing/preview` **不是**公开接口：不带账号 `Authorization` 就是 HTTP 401
  （2026-11-13 实测，五个账号全挂在「the plan list: Unauthorized」）。
- 领取被阿里云验证码守着：没有 `X-Aliyun-Captcha-Verify-Param` 回 3007。参数由
  `client/configs` 的 `data.configs.captcha`（`sceneId` / `region` / `prefix`）决定，
  在受控 Chromium 里用阿里云官方 SDK 的 `startTracelessVerification()` 换出来。
- 实测（2026-11-13）：无感验证 3.6~14 秒出参数（280 字符）；带参数 POST `claim` 传一个
  不存在的 plan id 回 `1001 target not found` —— 说明参数被服务端接受；不带参数回 429。
- ZCode 的事件上报（`/api/v1/event/report`）字段是 `element_name` / `event_id` / `user_id` /
  `screen_resolution` / `device_os_*` / `marketing_params`；发 `event` + `platform` 服务端
  虽然回 200，但不计数，preview 会一直回空 plans。
- 服务端按 `device_mid` + 日期去重：多账号共用一个 `X-Device-Mid` 会互相顶掉，所以每个
  账号一个（只有 key 的账号用 key 派生稳定 UUID）。

## 验证码浏览器

`src/captcha.mjs` 用受控 Chromium 跑无感验证，三条边界写错会静默失败：

- **真窗口、屏幕外**，不是 headless —— 无感验证看浏览器指纹，纯 headless 更容易被要求人工；
  需要 headless 时显式 `MAGPIE_ZCODE_CAPTCHA_HEADLESS=1`。
- **只跑无感**，8 秒没通过就失败 —— 签到是后台跑的，没有人会来点「点击完成验证」。
- **全局串行** + 清理：Chrome 启动器会 re-exec，只按 spawn 的 pid 杀会漏（实测 5 个临时
  profile 残留、Chrome 还挂着）；按 pid + 命令行里的 profile 路径双杀，`rmSync` 带重试，
  下次解法开始前再扫掉两小时前的残留。

## 架构

`index.mjs` **只做九项钩子的装配**，实现全部在 `src/`：

| 文件 | 管什么 |
|---|---|
| [`src/zcode.mjs`](../src/zcode.mjs) | 身份、端点、`app_version`、静态模型表、纯函数（uuid / jwt / 时间 / 数字） |
| [`src/zai-call.mjs`](../src/zai-call.mjs) | Z.ai 风格 JSON 端点调用（`{code,msg,data}` 信封、`ZError`、`Retry-After`） |
| [`src/keys.mjs`](../src/keys.mjs) | 把登录态换成计划自己的 API key（默认项目里的 `zcode-api-key`、团队 key） |
| [`src/signin.mjs`](../src/signin.mjs) | 登录流程：OAuth 轮询、Coding Plan、团队席位、Start Plan 的兜底 |
| [`src/own.mjs`](../src/own.mjs) | 跟随 ZCode App 自己的登录（`~/.zcode/v2`、加密凭据、key location） |
| [`src/session.mjs`](../src/session.mjs) | 把 magpie 存的 auth 还原成请求要的 `{site, base, key, jwt, device, uid}` |
| [`src/plan.mjs`](../src/plan.mjs) | 请求该走哪条路（`plansOf` 缓存）、限流/拒绝的短时记忆 |
| [`src/gift.mjs`](../src/gift.mjs) | 赠送额度（Start Plan）余额读取与 bucket 归属 |
| [`src/allowance.mjs`](../src/allowance.mjs) | 额度卡片：Coding 窗口、团队席位、Start Plan、重置次数 |
| [`src/claim.mjs`](../src/claim.mjs) | 每日领取（`auth.checkin`）、限流挂起 |
| [`src/captcha.mjs`](../src/captcha.mjs) | 领取的安全验证：受控浏览器跑阿里云无感验证，拿 `captchaVerifyParam` |
| [`src/catalog.mjs`](../src/catalog.mjs) | ZCode provider 配置 → 模型条目（`provider.models`） |
| [`src/start.mjs`](../src/start.mjs) | Start Plan 请求整形（头、`dress`、`queryOf`、ToolSearch 改名） |
| [`src/concurrency.mjs`](../src/concurrency.mjs) | 在飞并发闸、被拒重试、整机防火墙挂起 |
| [`src/answer.mjs`](../src/answer.mjs) | 回答原样交回（`kept`）、200 里的「额度用尽」说成 429 |
| [`src/loader.mjs`](../src/loader.mjs) | 请求接管（`auth.loader`）：选路、整形、重试、槽位释放 |
| [`src/prompt.mjs`](../src/prompt.mjs) | ZCode 自己的 system 文本（3.17.2） |
| [`src/browser-login.mjs`](../src/browser-login.mjs) | 一次性 Chromium + CDP 取 Cookie（OAuth 登录、验证码都用它） |

`src/` 里其余模块（`http.mjs`、`quota.mjs`、`store.mjs`、`usage-cache.mjs`、`models.mjs` 等）
是 magpie 插件模板带的通用层，本插件没用到，但它们的测试仍在跑。

## 开发

```bash
node --test                      # 全部测试（含上游移植过来的套件）
node scripts/check.mjs           # 交付门：身份、图标、错误码、UA、registry 条目
node scripts/check-docs.mjs      # 文档时新性：版本号、台账数字、断链
node scripts/check-error-codes.mjs .   # 只查错误出口
node scripts/check-ua.mjs .      # 只查出站 User-Agent
npm pack --dry-run               # 看发布包里有什么
```

测试跑在 node 上，`tests/support/` 提供三个兼容层：

- `bun-test.mjs` —— 上游 `bun:test` 的 `test` / `expect` / 生命周期 / `spyOn`（语义对齐 bun）；
- `home.mjs` —— 把 `homedir` 指到一次性目录（Windows 上同时设 `HOME` 与 `USERPROFILE`）；
- `bun.mjs` —— `Bun.serve` / `Bun.sleep`，用本地服务器当假上游。

⚠ 测试不许读写真家目录里的 `~/.zcode`；`home.mjs` 没装到第一行就会读到用户自己的登录态。
