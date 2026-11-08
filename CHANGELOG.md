# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

## 0.3.12 — 2026-11-04

**修：`pre-push` 误拦 tag 推送（0.3.11 实装当天真卡过一次）**

- `scripts/hooks/pre-push`：这一批 ref 全是 `refs/tags/*` 时直接放行。tag 推送是发布动作，`release.mjs` 已经跑过 check / test / pack，钩子再跑一遍既重复、又会在 `npm test` 偶发波动时把 tag 钉死
- 现象：`node scripts/release.mjs --yes` 里 `tag v0.3.11 … 失败`，本地 tag 有、远端没有，而脚本只打印一句"Release 交给 release.yml"，看起来像已经发了
- 判据：`git ls-remote --tags <remote> | grep v<版本>` —— 远端没有这个 tag 就是没发；混合推送（分支 + tag）仍按分支规则跑门禁

## 0.3.11 — 2026-11-04

**本地钩子一条命令装好：提交前脱敏 + 推送前分级门禁**

- 新增 `scripts/install-hooks.mjs` 与 `scripts/hooks/`：`node scripts/install-hooks.mjs` 一次装两个钩子 —— `pre-commit` 跑 `privacy-scan --staged`（毫秒级），`pre-push` 跑快档 `check` + `privacy-scan`（实测 0~1 秒）
- `pre-push` **按合入点分级**：只有在推 `main`、`git push -u` 首次推一个新分支、或显式 `PLUGIN_FULL=1` 时，才加跑 `npm test` / `check-docs` / `pack --dry-run`（实测约 3~5 秒）。WIP 分支的后续推送只过快档 —— 派生项目长大后测试会变慢，分级是让钩子不被绕过的前提
- 逃生门 `PLUGIN_SKIP_HOOK=1 git push` 只跳过**这一次**，不是永久关闭
- `scripts/create.mjs`：输出的「接下来」从五件事变六件，第 5 条是 `git init` 之后跑 `install-hooks.mjs`
- `AGENTS.md`：新增 §8.3b（钩子表 / 为什么分级 / CI 触发面的收窄办法）；§8.3 的 pre-commit 一行命令保留为「只想挂脱敏」的简化路径
- 起因：`ci.yml` 的五步（check / test / docs / privacy / pack）在本地没有任何东西兜底，漏跑任意一步就是「推上去才发现红」+ 一封 Actions 失败邮件。实测模板全套本地不到 5 秒，没有理由留到 CI 才发现

## 0.3.10 — 2026-11-04

**新增 `scripts/check-ua.mjs`：出站 User-Agent 必须是官方客户端 UA**

- `scripts/check-ua.mjs`：扫 `index.mjs` + `src/`，查四类 —— 自产品名形态（`magpie/…`、`magpie-xxx/<ver>`、`alysis-magpie/…`）、运行时默认（`node` / `Bun/…` / `undici`）、**截断的 Mozilla 残句**（缺 `(KHTML, like Gecko) Chrome/… Safari/537.36`）、以及「打非本机上游却没设 UA」（这一类是警告）。注释里的示例不算违规；`tests/` 与 `scripts/` 不扫（夹具与打 GitHub API 的请求是故意的）。`npm run check` 一起卡这条
- 起因是一条会静默出错的链路：上游网关按 `<product>/<version>` 形态认出「第三方客户端」，回 `403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}` —— **文案说网络繁忙**，用户重试 / 换号全没用。而 magpie 给插件的请求带 `User-Agent: magpie/<version>`，插件不显式设 UA 就把它透传上去，一样命中。实测（同一签名、同一请求体，只换 UA，交替 3 轮）：`<产品名>/0.2.1-rc.2` 带不带 `(+url)` 都 403，`<产品名>`（无版本号）/ `curl/8.7.1` / 不发 UA 都 200
- `src/http.mjs`：`baseHeaders()` 的默认 UA 从 `magpie-plugin/0.0.0` 换成新增的 `OFFICIAL_UA`（完整合法 Chrome UA）；`src/api.mjs` 的 `headersFor()` 同改。**模板本身就在教坏值** —— 派生仓库照抄 `magpie-plugin/0.0.0` 的已有先例（alysis / monkeycode 都中过）
- `src/tempmail-client.mjs`：两处 `fetch` 补 `user-agent`
- `AGENTS.md`：坑表新增第 38 条（403 `TM.00000001` 查 UA）；`README` 的「3. User-Agent 常常是硬校验」扩成四个小节（为什么会静默出事 / 宿主透传那一半 / 官方 UA 三条取法 / 判据）；`CHECKLIST.md` A 表加第 19 条
- `tests/check-ua.test.mjs`（11 项）；`npm run check:ua` 一条命令自查

## 0.3.9 — 2026-11-04

**新增 `src/catalog-union.mjs` 与 `scripts/app-icon.mjs`：多目录模型合并 + 从客户端安装包取官方应用图标**

- `src/catalog-union.mjs`：`catalogRows`（认三种目录形状、嵌套 `model` 内层优先）/ `isChatLike`（别名、补全、输出 ≤256、`text-to-image` 挡在聊天列表外）/ `mergeCatalogs`（主目录优先、补集补 id 与促销表、两份都读不到要抛）。起因是厂商的「客户端配置」更新慢、「控制台」那份带完整分角色元数据 —— 只读一份的后果不是报错，是插件里的模型比网页上少几个、倍率还是旧的
- `scripts/app-icon.mjs`：从 Windows 客户端 exe 的 PE 资源 `RT_ICON` 里取官方应用图标（16~256 多档），`--data-uri` 直接出 magpie 的 `icon` 字段值。**按资源树取而不是按 PNG 签名扫** —— 安装包里的界面插图也是 PNG，扫签名取到的会是插图；实测 WorkBuddy 5.9.3 取出的 256 档 sha256 与手工提取逐字节一致
- `AGENTS.md`：坑表新增第 36 条（卡片图标是圆的 —— magpie 画在圆角方框里，官网 favicon 常是正圆）与第 37 条（两份模型目录）；第三节命令加 `app-icon.mjs`；第五节模块表加一行，规模更新为 index 569 行 / `src/` 28 文件 5,331 行 / 28 个测试
- `tests/catalog-union.test.mjs`（9 项）、`tests/app-icon.test.mjs`（4 项）；两套逻辑已在 `MYCF711/magpie-workbuddy` 0.1.5 与 `Ghandi/workbuddy-pro` 的 PR !1 里跑过

## 0.3.8 — 2026-11-03

**从当前真实启用的 magpie 插件回收通用协议：HTTP / OAuth Device / 流读取 / 签到 / live models / 缓存**

- 新增 `RECYCLING.md`：以 `plugins.json` 为真源盘点 17 个实际启用项，记录版本、来源、已覆盖模块、择优理由与明确不回收的厂商业务
- 新增 `src/http.mjs`：统一错误响应、异构错误摘要、保守 401/403 判定与 Retry-After；新增 `src/status.mjs`：只读 400/422 clone 的分类与安全 Response 改写
- 新增 `src/credential.mjs`：凭据读取、指纹、cached → metadata → shape 的种类识别与 uid；新增 `src/oauth-device.mjs`：RFC 8628 设备码申请、轮询与刷新
- 新增 `src/checkin.mjs`：前后账单差集对账；新增 `src/stream-reader.mjs`：空闲超时不丢在飞数据块，支持 abort / done / error 重放
- `src/models.mjs`：新增稳定 slug/code 映射与同 id 元数据合并；`src/openai-sse.mjs`：不再折出无名 tool_call，整轮只有无名调用时给可重试 502
- `src/store.mjs` / `src/invite.mjs`：独立临时名、0600/0700、原子替换与厂商时区日键；邀请存储复用同一写原语
- `src/quota.mjs`：无 zone 时间支持显式 offset；`src/usage-cache.mjs`：新增 stale-while-revalidate；`index.mjs`：签到按账号 single-flight
- `src/api.mjs`：不再把任意 400/422 当模型 404，也不再把所有 403 当登录失效；全部新增与修改路径都有离线语义测试
- 审查加固：流终态向所有等待者广播；设备轮询 deadline 覆盖在飞请求；usage/checkin 不再用可重名 accountId 作 key；补齐中文模型 401、400/422 的 503/504、reasoning-only 无名调用、partial capabilities、SWR failTTL 与 refresh-only OAuth 回归

## 0.3.7 — 2026-11-02

**新增 ERROR-CODES.md：错误码规范 + 可执行检查，约束「每条错误都带 status + code」**

- `ERROR-CODES.md`：状态码 → 宿主行为对照表、12 个冻结的 `code` 词表（标了可重试/换号有救）、R1–R9 硬性规则、SSE 错误帧形状、最小实现模板、交付验收清单
- `scripts/check-error-codes.mjs`：静态近似检查 R1/R2/R4/R6/R8（脚手架自身全绿；对已知有缺陷的插件能抓到「端点不存在用 404」这类会被宿主当成模型坏了的错法）
- 并入 `npm run check`（`check.mjs` 新增一条断言），也可 `npm run check:errors` 单独跑
- `CHECKLIST.md` A 表新增第 17/18 条；`AGENTS.md` 坑表新增第 14 条；`HOOKS.md` 第七节指过去

## 0.3.6 — 2026-10-31

**修复 Windows 上 publish-npm 的 spawn 失败：`spawnSync("npm")` 找不到 npm.cmd**

- `publish-npm.mjs` 改用 shell 执行 `npm publish`，Windows / Linux 都能跑；失败时打印 `r.error` 的错误码
- 0.3.5 的 CI 幂等、GitHub Template 文档、派生 CI 严格化全部包含

## 0.3.5 — 2026-10-31

**CI 发布同版本时按成功处理：npm 的 staged 窗口不再让 release workflow 假红**

- `publish-npm.mjs`：捕获 npm 输出；`CI=true` 且报 E409 / previously staged 时 warning + exit 0；本地仍报错提示 bump
- `create.mjs`：派生项目复用脚手架这份 `publish-npm.mjs`（只替换 `PUBLISH_AS`），不再各自维护一份
- 保留 release.mjs / release.yml 的发布前守卫与 `NPM_TOKEN` 缺失显式失败
- 支持 GitHub Template：README/GUIDE 写明「Use this template」与本地 create.mjs 的区别；create.mjs 把派生项目 ci.yml 的 action 自测从 `template: "true"` 改为 `"false"`，不再替占位符放行

## 0.3.4 — 2026-10-31

**发布刚完成时 npm view 还没刷新，workflow 仍会 E409；现在发布失败后再查一次，同版本已存在就按成功处理**

- `release.yml`：publish 非 0 后 sleep 5 再 `npm view`；同版本已在 npm 则 `::warning` + exit 0，避免 staged 窗口误红
- 保留「发布前先查、已存在直接跳过」与「NPM_TOKEN 缺失显式失败」

## 0.3.3 — 2026-10-31

**npm 发布全链路幂等：本地发过、tag 触发的 workflow 重跑不再 409 变红**

- `release.mjs --npm`：发布前 `npm view <pkg>@<version>`；已存在则跳过 npm 并继续 tag/Release，不中断流程
- `release.yml`：npm 步骤先 `npm view`，已存在则 `already published, skipping` + `exit 0`（保持绿）
- `scripts/npm-name.mjs`：从 `publish:npm` 的 `PUBLISH_AS` 解析真正的 npm 名，派生项目也能用
- `check.mjs`：检查 `release.yml` 有版本守卫；`NPM_TOKEN` 缺失仍然显式失败（不假绿）
- README / UPDATING：写清「手工发过后重跑 workflow 是安全的」

## 0.3.2 — 2026-10-31

**包名回到 slug，显示名写 `magpie.name`；`plugin update` 不再被空格依赖键打挂，npm 发布能力标准化**

- `package.json.name` 必须是 slug（小写 ASCII，无空格/中文/大写）；显示名写 `package.json.magpie.name`（`shownName()` 优先取它），provider 与 registry 的 `name` 同步
- 修复：旧版把 `华为云 HUAWEI` 写进 `name`，bun 依赖键带空格，`magpie plugin update` 报 `unrecognised dependency format`；迁移步骤见 UPDATING「旧版带空格依赖键」
- `scripts/check.mjs`：新增 slug / `magpie.name` / registry 显示名检查；要求 `publish:npm` 脚本、`publish-npm.mjs` 文件、`release.yml` 引用 `NPM_TOKEN`
- `scripts/publish-npm.mjs`：发布失败也在 `finally` 还原 `package.json.name`；同版本已存在时打印可读错误并提示 bump
- `release.yml`：没配 `NPM_TOKEN` 时**显式失败**（不再 `exit 0` 假绿），并给 `::error` 提示
- `scripts/create.mjs`：`--name` 写 `magpie.name`，`--package` 写 slug；自动生成 `publish-npm.mjs` / `publish:npm`，派生项目默认严格检查
- 新增 `src/browser-login.mjs`：受控 Chromium 登录（Windows 注册表优先、覆盖 360/QQ/搜狗等国产浏览器，CDP 取 Cookie），从 WPS 灵犀 0.4.11（MIT）的实测实现抽取；带纯函数单测
- README / UPDATING / CHECKLIST / GUIDE / README-TEMPLATE / AGENTS / SCORING 同步新口径；删除「显示名写 `package.json.name`」的旧说法
- 修复：tag 触发的 release.yml 发现同版本已在 npm 时跳过并给 warning，不再因本地已发布而 409 变红；npm 包名由 `scripts/npm-name.mjs` 解析

## 0.2.0 — 2026-10-31

**显示名约定：插件标题与 provider 名都改成「中文 + English」，模板默认放显眼占位符，没改就过不了 check**

- 约定：`package.json.name`（卡片标题）与 provider `name` 都写成 `<中文> <English>`，英文部分按厂商官方品牌字样的大小写照抄；npm 包名另由 `publish:npm` 注入，不能拿包名当显示名
- 模板默认值改成 `⚠ 未命名插件 Unnamed Plugin` / `⚠ 未命名供应商 Unnamed Provider`；看到占位符就说明身份还没改
- `scripts/check.mjs` 新增：显示名 / provider name 含 `未命名`、`Unnamed`、`TODO` 时失败；必须同时含中文、English、空格；显示名不得等于 npm 包名；registry 一致性改为核对 npm 包名
- `scripts/create.mjs` 强制 `--name`（格式校验），`package.json.name` 写显示名，并生成 `scripts/publish-npm.mjs`（`PUBLISH_AS` = npm 包名）；派生项目不再继承 `check:template`
- 脚手架自身用 `--template` 才允许占位符；CI 与自测 Action 走这个开关，派生项目默认严格
- 新增 `scripts/publish-npm.mjs`（脚手架自己的 npm 名仍是 `magpie-plugin-scaffold`）；README / UPDATING / GUIDE / CHECKLIST / README-TEMPLATE / AGENTS 同步约定与占位符机制

## 0.1.34 — 2026-10-30

**新增可选的工具 schema 适配器：超长工具名截断 + 上游工具 schema 兼容改写（默认关闭）**

- 新增 `src/tool-schema.mjs`：`truncateToolName` / `truncateToolNames`（超长工具名截断、同前缀撞车自动加序号保唯一）、`loosenToolSchema` / `adaptToolList` / `rewriteToolSchema`（`additionalProperties` 非布尔换 `true`、删 `items:{}`、`items` 子树摊平 `anyOf` 且不留空 `{}`）、`createToolSchemaAdapter({ enabled: true })` 显式启用；不传 `enabled: true` 时原样返回入参
- 新增 `tests/tool-schema.test.mjs`（17 条）：默认关闭 identity、工具名唯一性、`additionalProperties` 布尔边界、`items:{}` 删除、`items` 子树 union/空 schema、深冻结不可变
- AGENTS / README 的模块表与计数同步（`src/` 20 文件 / 3,716 行，tests 16 个），README 的 `npx` / Action 示例 tag 指向 `v0.1.34`

## 0.1.33 — 2026-10-30

**补上额度读取缓存与请求体改写管道，并把 usage 缓存真正接进入口**

- 新增 `src/usage-cache.mjs`：按凭据 key 缓存 `usage()`（成功 60 秒 / 失败 5 秒）、同 key 并发合并、`publicUsage` 去内部字段、`exhausted` 无读数时放行；`index.mjs` 的 `auth.usage` 已接入（key = uid/accountId/refresh/access）
- 新增 `src/request-rewrite.mjs`：`rewriteJsonBody` identity 快路径 + `ensureStreamUsage` / `clampMaxTokens` / `stripModelPrefix` / `stripHopHeaders`；工具 schema 与 `additionalProperties:false` 绝不改
- 新增 `tests/usage-cache.test.mjs`（9 条）与 `tests/request-rewrite.test.mjs`（9 条）
- README / AGENTS 的模块表与计数同步

## 0.1.32 — 2026-10-30

**修 0.1.31 的 npx 入口：一个包两个 bin 时 npx 不知道跑哪个，`npx github:...` 直接报错**

- `package.json.bin` 改为单一 `magpie-plugin`，子命令 `check` / `create`；这样 `npx --yes github:MYCF711/magpie-plugin-scaffold#v0.1.32 check .` 与 `... create ...` 都能直接跑
- 新增 `scripts/cli.mjs` 只做分发，实际实现仍在 `scripts/check.mjs` / `scripts/create.mjs`
- README、Action 注释、create 示例统一指向 `v0.1.32`
- `tests/adoption.test.mjs` 增加 CLI 分发与「只能有一个 bin」的断言

## 0.1.31 — 2026-10-30

**把「怎么用」从克隆仓库降到一条命令，并让已有插件只跑 check**

- 新增 `magpie-plugin-create`：`npx github:MYCF711/magpie-plugin-scaffold#v0.1.31 create --dir ... --provider ...` 复制模板、自动改 `PROVIDER` / `PROVIDER_NAME` / `BASE` / 请求头 / registry 条目；拒绝覆盖非空目录，不联网、不装依赖
- 新增 `magpie-plugin-create` 的 `package.json.bin` 与 `npm run create`
- 新增可复用 GitHub Action `.github/actions/check`：`uses: MYCF711/magpie-plugin-scaffold/.github/actions/check@v0.1.31`，直接跑模板里的 `scripts/check.mjs`，不下载 npm 包、不写被检查目录
- `package.json` 暴露 `magpie-plugin-check` bin，配合 `npx github:` 无需先克隆
- `tests/mount.test.mjs` 不再硬编码 `xxx`：派生插件的 provider id 换掉后，挂载契约仍能跑
- 新增 `tests/adoption.test.mjs`：check CLI、create CLI、非空目录保护、bin 与 Action 接线
- CI 新增 `action-self-test` job，用本仓库的 Action 检查本仓库

## 0.1.30 — 2026-10-30

**补上四个厂商无关原语，把「文档宣称有、代码没有」的洞填上**

- 新增 `src/refresh-lock.mjs`：`createRefreshLock({replayMs})` 同 key 合并 in-flight、成功回放 60 秒、失败不缓存、`clear()` / `sweep()`；`index.mjs` 的 `auth.refresh` 已真实接入（键 = `PROVIDER + "\n" + refresh_token`），README 宣称的「并发去重闸」不再是空话
- 新增 `src/oauth-pkce.mjs`：`generatePkce()`（S256）/ `randomState()` / `startLoopback()`（127.0.0.1 随机端口、state/Host 校验、错误 path 404 不结束、错误 state 400 可重试、超时/abort/close reject）——只提供原语，不接默认登录流程
- 新增 `src/model-context.mjs`：`createModelContext()` 查 `~/.cache/magpie/models.json`（精确 id / 尾段 / 多厂商前缀取最大、大小写不敏感、TTL 缓存、坏 JSON 与文件缺失不抛）；`src/models.mjs` 的 `contextOf()` 改为调用它，查不到返回 `undefined`（不猜）
- 新增 `src/openai-sse.mjs`：`parseSse` / `readSseEvents` / `openAIEvents` / `foldOpenAI`（CRLF、多行 data、注释、BOM、`[DONE]`、UTF-8 跨块、32 MiB 上限、usage 帧、tool_calls 分片）——只解析/折叠，不默认改写请求
- 修复 `src/quota.mjs`：`usage()` 的 routable 判据改为 `w.aside !== true && (w.used !== undefined || w.balance !== undefined)` —— 只有 `balance` 的钱包窗口不再被误杀
- 修复 `src/models.mjs` / `src/context.mjs` / `index.mjs`：`provider.models` 路径的 `capabilities.input` 补全 `audio` / `video` / `pdf` 布尔（`output` 保持 `{ text: true }`，不发明契约外字段）；`config` 静态模型补 `modalities: { input: ["text"], output: ["text"] }`（宿主 config 路径读 modalities，不读 capabilities）
- 修复 `src/account-name.mjs`：`maskPhone` 只在「0086 + 11 位」或「86 + 11 位」时剥国家码；7–10 位短号返回空串，不再把原号码全部数字打在卡片上；11 位、本身以 86 开头的号码不再被误剥；已打码值保持原样
- 新增 `tests/mount.test.mjs`（入口唯一函数导出 / 九钩子 / config 模型 / modalities / loader 形状 / usage 构造器 / refresh-lock 接线）与四个模块的独立离线测试；`node --test` 全绿
- 新增 `NOTICE.md` 并在 `package.json.files` 收录；版本 0.1.30

## 0.1.29 — 2026-10-30

**「自己给自己提 PR 有必要吗」—— 实测答案：是必须的。我上一版的推断错了，实测把它推翻了**

主人问：在分支实验，没问题了就推主仓库，不行吗？我先查了分支保护 API，看到
`required_pull_request_reviews.required_approving_review_count = 0`，判断「PR 没有评审 ⇒ 只是仪式」，
于是把 5 个文件的表述改成了「PR 可选」。**然后实测直推 `main`：**

```
$ git push origin docs/pr-optional:main
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - Changes must be made through a pull request.
 ! [remote rejected] docs/pr-optional -> main (protected branch hook declined)
```

**为什么推断错了**：GitHub 的 `required_pull_request_reviews` 这个字段，
**为 `null` = 不要求 PR；为一个对象（哪怕 `required_approving_review_count = 0`）= 要求 PR，只是不需要批准**。
我只读了对象里的数字，没读「对象存在」这件事本身。

所以真正的结论是：

| 项 | 值 | 含义 |
|---|---|---|
| `required_pull_request_reviews` | 对象存在，`count = 0` | **必须走 PR 通道，但零批准** —— 自己就能合并 |
| `required_status_checks` | `["rules"]`, `strict: true` | PR 上必须 `rules` 绿 |
| `enforce_admins` | enabled | 管理员也绕不过 |

**所以 PR 不是仪式，是 GitHub 对受保护分支硬性要求的唯一入口。**
可省的不是 PR，而是 **`required approvals`**（保持 0，否则自己合不了）。

- 本版把上一版改错的 5 处表述全部回滚成「必须 PR」，并在 [UPDATING](./UPDATING.md) 的配置表里写明这次实测的报错原文与 `null` vs 对象的区别
- **[UPDATING](./UPDATING.md) 新增一节**「为什么 PR 不能省」，附实测命令与输出

> 起因：自己给自己提 PR 看着确实像仪式。但**「像仪式」和「是仪式」是两件事** ——
> 这次靠一次真推就分清了。教训：**读 GitHub API 的布尔语义，要看字段是否存在，不只看里面的数字。**

**主人随后补了一句，把这条规矩的真实来由说清楚了：**

> 建分支曾经是因为怕把别人在用的插件炸了。所以要分支推测试版本，`main` 推稳定版本。

这比「PR 门禁」更根本 —— 分支不是「暂时放代码的地方」，是**测试版本的分发通道**：

| 通道 | 写在哪 | 用户怎么装 | 谁拿得到 |
|---|---|---|---|
| **稳定版** | `main` | `magpie plugin add github:owner/repo` | 所有人（git 源会提示更新） |
| **测试版** | 任意分支 | `magpie plugin add github:owner/repo#feat-x` | **只有显式写 `#ref` 的人** |

官方契约（`#run`）：git 仓库按 `github:owner/repo[#ref]` 拉取；更新检测比「它的分支或标签
（不写 `#ref` 时是默认分支）指向的提交」。⇒ **分支上怎么折腾都不会影响用 `main` 的人。**

所以两件事分清了：

- **「怕炸了别人」的解法是推分支**，不是「晚点推」—— 想试的人显式带 `#feat-x` 就能拿到
- **PR 是 GitHub 对受保护分支的技术要求**（`GH006`），批准数 0、自己就能合，不是评审流程

[UPDATING](./UPDATING.md) 新增「一之前 · 分支和 `main` 各管什么」一节，用户侧补了装测试分支的命令；
[AGENTS](./AGENTS.md) 与 [README](./README.md) 同步了这个说法。
## 0.1.28 — 2026-10-30

**issue #468 全部被接受：四条进了官方文档 v0.1.1934，其中两条是真 bug —— 但我们有两条把因果说错了**

[#468](https://github.com/magpie-community/plugins/issues/468) 发出后 **1 小时 22 分**就收到 yetone 回复，
当天关闭。官方逐条核对了源码，结论是：**两条是真 bug 已修，另两条原因与我们说的不同，四条全部写进指导文件**
（en / zh / ja，v0.1.1934，commit `3ec25523c` / `1390aa458` / `5957d45ac` / `1319a44bb`）。

| # | 我们说的 | 官方结论 |
|---|---|---|
| 1 | `aside` + `amount`/`limit` ⇒ 整条窗口被丢 | **因果错**：判断只看 `used`，与 `aside` 无关。没有 `used` 的窗口才是 text-only；`aside` 是路由**显式**跳过的另一个独立条件。`1390aa458` 起，有 amount+limit 无 used 会取 `amount/limit` 作占比 |
| 2 | 模型级 401 打死**一个账号** | **对，而且更宽**：401 可重试 ⇒ failover 到**每一个账号**，每个都标登出。`3ec25523c` 起按 401 的 body 区分；插件仍应回 **403/404** |
| 3 | `free` 不能从 `rate === 0` 反推 | **半对**：magpie 确实不从 `rate` 推 `free`，`rate: 0` 只是「没给倍率」；我们测到的 38/51 是我们**自己的插件**从计费端点推出来的 |
| 4 | LICENSE 必须逐字 MIT | **对，且已加回退**：`NOASSERTION` 的 listing 改用 `package.json` 的 `license` |

**代码同步（[`src/quota.mjs`](./src/quota.mjs) 按新机制重写）：**

- `amount` + `limit` 没给 `used` ⇒ **自动算 `used = amount/limit×100`**（跨 magpie 版本一致，不依赖 ≥0.1.1934 的推算）
- `aside: true` 仍不许给 `amount`/`limit`，但理由改成「**假占比**：分母就是余额本身，永远剩余 100%」
- 没有 `used` 的窗口要 text-only 必须**显式** `textOnly: true` + `display`
- `usage()` 新增：**所有窗口都是 `aside`/`textOnly` ⇒ 抛** —— 那个号在路由页就是「剩余额度未知」，且排在已知账号之后
- 测试 22 → **27 条**（11 条额度窗口），全 repo 52 条

**文档同步：** AGENTS 坑 2 / 6 / 9 / 22 / 24、HOOKS 三·规矩① 整节（加 #468 更正块）、GUIDE 第 6 步、
OFFICIAL-SOURCES 增量清单（4 条标为「已进官方文档」）。

> 起因：issue 发出后主人问「结果如何了」。结果是好的，但暴露了一个方法论问题 ——
> **我们把「观察到的现象」和「推断的原因」写在一起了**。四条里两条原因错，官方仍全部收下并改了代码，
> 说明**可验证的观测值是最硬的部分**；也说明下次报 bug 要两段分开写：
> 「我看到什么」与「我猜为什么」。这条已写进记忆库。

## 0.1.27 — 2026-10-29

**维护方式从「可以直接推 main」改成「功能分支 → PR 门禁 → 合并后受控发布」。**

- **默认分支禁直推**：UPDATING / GUIDE / CHECKLIST 与派生仓库维护入口统一为功能分支流程；GitHub 保护要求 PR、`rules` 检查、分支最新、讨论解决，管理员也不绕过。
- **CI 不再吞测试失败**：删除 `|| true`，`rules` 现在依次跑 `check.mjs`、语义测试和 `npm pack --dry-run`。
- **`release.mjs` 不再推默认分支**：本地 HEAD 领先 `origin/main` 就拒绝；只有与已合并远端完全一致的提交才能发。发布前会真实重跑合规、测试和打包预演。
- **`release.yml` 增加发布门**：tag 必须匹配 `package.json`，tag 提交必须已经进默认分支，检查 / 测试 / pack 全过才建 Release 或发 npm；手动刷新 Release 正文也正确使用输入的 tag。
- **成熟实践来源**：采用 GitHub protected branches 的必需 PR / 状态检查模型；参考 release-please 的 Release PR 思路，但保留本仓库现有发布脚本，不新增第二套版本机器人。

> 起因：主人指出，直接推包可能把坏包分发给正在使用的人；以后只能起分支，确认没问题后经 PR 合并成新版本。

## 0.1.26 — 2026-10-29

**账号名那条规矩补齐：`accountId` 是名字，`uid` 是身份 —— 内部 ID 不许当名字。**

- **新增 [`maskPhone`](./src/account-name.mjs)**：`0086-<PHONE>` / `+86 138 0013 8000` / 裸号 / 厂商已打码的值，一律给出 `138****8000`。国家码只在后面还剩够长的号码时才砍（`86123456789` 这种 86 开头的真号不会被砍成 9 位）。
- **新增 [`looksLikeIdentifier`](./src/account-name.mjs)**：`iam::<domain>:user:<name>`、`urn:…`、uuid、裸 hash、华为 IAM 的 `hw061571365626786` —— 一眼看出是 ID 的形状，不当名字。
- **新增 [`resolveAccount`](./src/account-name.mjs)**：登录成功时直接拿到 `{ accountId: "138****8000", uid: "iam::…" }` —— 名字给人看，身份给宿主去重（HOOKS 八的 `settle`）。名字全取不到就**不给 `accountId`**，让宿主回退供应商名，**绝不拿 URN 顶上**。
- **`accountLabelOf` 行为变了（默认打码 + 跳过像 ID 的值）**：`mask` 默认 `true`、`allowId` 默认 `false`；要旧行为显式传 `{ mask: false }` / `{ allowId: true }`。
- **HOOKS 八** 新增「`accountId` 是名字，`uid` 是身份」：写错的代价是**永久性**的 —— `auth.refresh` 的返回值是合并，插件落盘又多保留旧值，URN 进去一次卡片就再也变不回来。所以**续期路径也要把 `accountId` 重算一遍**。
- **CHECKLIST A-15**：卡片上不许出现 `iam::…` / `urn:…` / uuid / `hw…`；手机号是打码的；名字取不到 = 空串；多账号重复登录仍是替换。
- **AGENTS 坑 27**：症状写的就是用户的原话 ——「一串看不懂的 ID，以为是乱码」。
- **新增 [`tests/account-name.test.mjs`](./tests/account-name.test.mjs)**（4 组 20 条断言：打码边界、ID 形状、名字与身份分离、优先级）；`node --test` **48 通过**。

> 起因：CodeArts 0.2.4 从 refresh token 的 `user_profile` 取 `principal_urn` 当账号名，三个账号在三张卡片上是三串 ID。0.2.5 改成登录后读一次华为云 IAM 的手机号（`GET /v3.0/OS-USER/users/{principal_id}` → `user.phone`），打码成 `138****8000`，URN 改走 `uid`，老记录在下次续期时改名 —— [magpie-community/plugins#483](https://github.com/magpie-community/plugins/pull/483)。

## 0.1.25 — 2026-10-29

**把 magicrew 真机链路里四块通用的「登录协议」抽成模块 + 44 条测试。**

- **新增 [`src/rotation-captcha.mjs`](./src/rotation-captcha.mjs)**：旋转图片验证码 —— 角度编码（`52249517*(deg+n)+5976906165 & 0xFFFFFFFF`，从前端反出来、抓 4 组提交穷举唯一命中）、按 origin 的 WAF cookie 罐（`acw_tc` 不带回去就回 `2000 客户端信息不匹配`）、`solveRotationCaptcha` 的「取图 → 判角 → 提交 → 不可信换图」循环。
- **新增 [`src/vision-clock.mjs`](./src/vision-clock.mjs)**：用 magpie 设置里那个识图模型判「主体上方向指向几点」—— 两个判官并行、分歧 >1.5 钟点判不可信、`max_tokens=6000` 是给推理留的（400 会把答案饿死）、`reasoning_effort:"low"` 被 400 时去掉重发。
- **新增 [`src/local-browser.mjs`](./src/local-browser.mjs)**：从本机 Chromium 系浏览器的 LevelDB 读 localStorage 登录态 —— 不开窗、不弹浏览器；按 origin 截断，避免 A 站 jwt 配到 B 站 org。
- **新增 [`src/tempmail-client.mjs`](./src/tempmail-client.mjs)**：temp-mail.io 一次性邮箱建址 + 轮询抽验证码；记录域名黑名单这一实测坑（`maxxspace.com` / `guerrillamailblock.com` / `mailinator.com` 会被部分上游拒）。
- **新增四个测试文件**（`vision-clock` / `local-browser` / `tempmail` / `rotation-captcha`），`node --test` 44 通过。其中锁死了：角度编码与前端公式逐字一致、cookie 必须从 generate 带到 verify、判角不可信必须换图、跨 origin 不串号。

## 0.1.24 — 2026-10-29

**把「登录」这一轮的真机经验抽成三个可复用模块 + 两处契约补漏。**

- **新增 [`src/invite.mjs`](./src/invite.mjs)**：邀请码 / 推荐码的通用做法 —— 策略文件（`~/.cache/magpie/<前缀>-invite.json`）、数字框语义（0/空=沿用、1=保持、其它=新码）、`makeInviteMethod()` 生成「邀请码 → 主登录」的登录方式。含一条实测坑：**换码必须一起换与码成对的额外字段**（Accio 的 `sId`，拿旧 `sId` 配新 `ic` 就是「填了码但邀请不生效」）。
- **新增 [`src/desktop-import.mjs`](./src/desktop-import.mjs)**：从本机 Electron 客户端导入登录态（Windows）—— Chromium OSCrypt `v10` + DPAPI，明确拒绝 `v11`/`v20`（App-Bound，解不开就报错而不是给乱码）。这条路**不弹浏览器**，前提是用户已登录过官方客户端。
- **新增 [`src/account-name.mjs`](./src/account-name.mjs)**：卡片上的账号名从哪来 —— 换码响应没有账号名时，登录后调一次「当前账号」接口；优先级「手机号（去 +86）→ 邮箱 → id → 空串」，失败不阻塞登录、不编造。
- **HOOKS 四·陷阱 5**：**多步问答必须用 `ask()`**，不是 `prompts` 数组。补上契约来源（`NextPrompt()` → 插件 `prompt` 钩子 → `method.ask`）、CLI/GUI 两处调用点、以及「只给 `ask` 不给 `prompts`，列表里那条看起来像什么都不问」。
- **HOOKS 四之二**：登录的三种形态（浏览器 OAuth / 本机客户端导入 / 内置 headless），各自弹不弹窗口、前提、实测结论，以及选择顺序。**内置 headless 不建议默认提供** —— 同一出口 IP 连续发码会被静默拦下。
- **新增 [`tests/invite-and-name.test.mjs`](./tests/invite-and-name.test.mjs)**：6 条语义锁（数字框三态、策略读写与额外字段继承、`ask` 三步序列、`authorize` 复用主登录、账号名优先级）。

## 0.1.23 — 2026-10-29

**模型能力那一栏，「不写」不等于「不支持」—— 补上这个静默误判**

- **HOOKS 十一之三**：`modalities.input` 的「不写则按 text 处理」是错的 —— magpie 只认 `input.image` 的布尔值（宿主按它算 `imageSaid`）；省略 = 厂商未表态 = 退到 models.dev 按裸模型 id 投票，同名模型在别家标过 `image` 就会被当成能收图。补了 text-only 模板与实测代价（CodeArts 0.2.3 的 161 次 `InferHub.001001020.406`）。
- **HOOKS 十一之三**：`imageSaid` 行改正为「宿主自动算的，插件不用写」。
- **CHECKLIST A 表**：加第 14 条 —— 每个模型都要显式声明 `capabilities.input.image`。
- **AGENTS 第二节**：加坑 25；坑 19 的 `modalities` 说明补上「`image` 省略 ≠ 关掉」。
- **新增 `scripts/probe-vision.mjs`** —— 把「这个模型到底能不能看见图」变成一条命令：内嵌一张写着 `MAGPIE-VISION-TEST 42` 的 PNG，对模型的回答分四类（能读到图 / 假声明 / 已标文本 / 看不出），有假声明时退出码 2。只读本机网关与 `settings.json`，不改任何配置。AGENTS 命令区已接上。

> 起因：本机 magpie 0.1.1932 上，ima / magicrew 的三个模型被手动勾成「接受图片」但厂商明确说 `image: false`，实测一个回「图片无法查看」、一个 400「不支持多模态输入」；CodeArts 则是插件漏写 `image` 被 models.dev 投票带偏，四天 161 次直发被拒。magpie 侧的三个修复点已提 issue yetone/magpie#4110。

## 0.1.22 — 2026-10-28

**把维护检查接进三个入口 —— 否则它只是一个「你知道才会跑」的脚本**

0.1.21 加了 `check-maintenance.mjs`，但它没出现在任何必经路径上，等于没有：

- **[CHECKLIST](./CHECKLIST.md) B 表第 7 步** —— 加第 ⓪ 条，放在四条验证之前
- **[UPDATING](./UPDATING.md) 第 7 步** —— 从「四条验证」改成「五条」，⓪ 排第一，并写明它抓的四种静默失配
- **[AGENTS](./AGENTS.md) 命令区** —— `node scripts/check-maintenance.mjs`，一句话说清后果
- **README / AGENTS / UPDATING 里所有「四条验证」** —— 统一改成「五条」

> 起因：一个没人跑的检查等于没写。接进交付门才算数。

## 0.1.21 — 2026-10-28

**维护标准从「七步写在文档里」变成「一条命令查出来」—— 而它第一次跑就抓到了我们自己**

主人指出：插件不是做完就完，**默认情况下大家会直接覆盖仓库、不发新版本、没有更新日志，完全不方便维护**。
核对后发现：七步写在 UPDATING 里，但**没有任何机制**，所以 —— **我们自己在 0.1.17~0.1.20 四个版本上只 commit 没打 tag**，
正是他说的那种情况。（已补 tag：v0.1.17 / v0.1.18 / v0.1.19 / v0.1.20。）

- **新增 [`scripts/check-maintenance.mjs`](./scripts/check-maintenance.mjs)** —— 六项维护检查：
  ① 是 git 仓库 ② 至少打过一次 tag ③ **当前 `version` 有对应 tag**（否则 Release 是空的）
  ④ **自上次 tag 以来改了代码，但 `version` 没变** ← 就是「直接覆盖仓库不发新版本」的检测器
  ⑤ CHANGELOG 有当前版本一节 ⑥ 没有跳过版本（中间每个版本都打了 tag）。
  退出码非 0 = 用户拿不到新版。
- **`package.json` 的 `scripts` 加 `maintenance`** —— `npm run maintenance`。
- 为什么它比文档有用：这六条**都不报错**，本地一切看起来都对，只有用户那边永远停在旧版本。
  这个脚本第一次对着自己跑就 FAIL 了一条（改了代码没 bump）—— 那就是它的用例本身。

> 起因：主人补了第三个维度 —— 「还有插件的维护标准呢……默认没有维护的适合直接覆盖仓库，不发新版本，
> 没有更新日志。完全不方便维护」。这句话把一个隐含假设点破了：**脚手架不只是「怎么开始」，还得管「怎么活下去」。**
> 所以我们自己先做了反面教材，再把检测器写出来。

## 0.1.20 — 2026-10-28

**「写错不报错，但 GUI 和智能路由会坏」的坑 —— 从「文档里写了」变成「代码里拦住了」**

主人指出：脚手架的价值不只是省重复步骤，更是那些**不做就会出 GUI bug、甚至让智能路由不工作**的地方。
核对后的结论是：**知识层有（AGENTS 第二十四到二十四条、HOOKS 三条窗口规矩），代码层没有** ——
`index.mjs` 的 `usage` 骨架原来只是一段注释 + 一个 `TODO`，写错了照样静默。

- **新增 [`src/quota.mjs`](./src/quota.mjs)** —— 额度窗口的构造器。五类写法直接 `throw QuotaShapeError`：
  ① 缺 `used`（会被当成 0% = 满额，空号排到路由队首）② `aside: true` 又给 `amount`/`limit`
  （`allowanceOf()` 整条跳过 ⇒ `routedAllowance` 不 ok ⇒ **这个号在路由里等于不存在**）
  ③ 钱包型（`balance`）又给 `used`（被当占比读）④ `resetsAt` 塞厂商原样时间（整条窗口被丢）
  ⑤ `span` 不是正整数。另附 `toIso()`：ISO / 秒 / 毫秒 / `"2026-10-28 23:59:59"` 统一转 ISO。
- **[index.mjs](./index.mjs) 的 `usage` 改用构造器** —— 上游失败才 `return {error}`；
  **写法错会抛出**（不被 catch 吞掉），因为那是编码错误，吞掉就又变成「GUI 坏了但日志里什么都没有」。
- **[tests](./tests/semantics.test.mjs) 16 → 22 条** —— 新增 6 条锁住上面那五类写法。
- **[AGENTS 第五节](./AGENTS.md)** —— 加了 `src/quota.mjs` 那一行和「五类写法 → 不拦的后果」的表。
- **[GUIDE 第 6 步](./GUIDE.md)** —— 改成「别自己拼窗口对象，用构造器」，并说明它是卡片与路由的**同一个输入**。

> 起因：主人补了一句「脚手架给出了很多不做就会出 GUI bug，甚至涉及智能路由无法工作的坑」。
> 这句话逼出一个更准的判据：**脚手架的价值 = 省掉的重复 + 拦掉的静默错误**。
> 第一项已经在 README/CHECKLIST 里兑现；第二项原来只有文档，这一版才补上代码。

## 0.1.19 — 2026-10-28

**盲测做了，抓出 6 个真缺陷 —— 其中 2 个会让合法插件永远过不了身份门**

方法：把脚手架交给一个**只读 `GUIDE.md` / `SCORING.md` / `AGENTS.md` 三份**的执行者，
让它做虚构供应商 Nimbus 的插件（API key 登录 / 两个模型 / 5 小时额度 / 每日签到）。
它做到了：`check.mjs` **29 通过 · 0 警告 · 0 失败**、`score.mjs` **身份门通过 · 65/65**、
`node --test` **18 通过 · 0 失败**。**但它第一轮被卡住过一次，卡住的点全是我们的错。**

### 它指出的问题 → 这一版修了什么

- **身份门 `BASE` 判据会误杀 `.example` 域名** —— 原判据是 `!/(^|\.)example\./i`，而虚构/示例厂商
  本来就该用 `api.<vendor>.example`，于是**合法插件永远过不了门**（它只能把字面量拆成两段绕过去）。
  改成「和模板默认值 `https://api.xxx.example/v1` 不同」+ 不含 `xxx`。
- **身份门只认入口文件里的 `const PROVIDER`** —— 而 [AGENTS](./AGENTS.md) 第五节又建议 `index.mjs` 只做装配、
  常量进 `src/`。它照 AGENTS 做了，身份门直接判失败。改成**入口 + `src/**` 一起找**。
- **[GUIDE](./GUIDE.md) 第 1 步没说要带走 `scripts/`** —— `score.mjs` 的 A 层读的是**你自己仓库里**的
  `scripts/check.mjs`，删了它 A 层直接 0 分。已在第 1 步写明「`scripts/` 和 `src/` 一起带走」。
- **[GUIDE](./GUIDE.md) 没讲 `type: "api"` 挡不住 key 格式** —— 官方没有 method 级 `validate`，
  `placeholder` 只是提示。已补：要拦就在 `loader` 里自己判断。
- **[GUIDE](./GUIDE.md) 没讲 usage/checkin 的上游端点由谁定** —— 官方只规定返回形状，端点/方法/请求体是厂商自己的。
  已补：模板里 `fetchUsage` / `doCheckin` 空着是**故意**留给你的。
- **[GUIDE](./GUIDE.md) 说「照抄 tests 再改」是误导** —— `tests/semantics.test.mjs` import 的是
  `../src/*.mjs`，只抄测试会 import 失败。已补：`src/` 必须跟 `tests/` 一起带走。
- **[HOOKS](./HOOKS.md) 把 `capabilities` 下的字段写成 `tool_call`** —— 官方 `#provider` 是 `toolcall`（无下划线），
  而 `#quick` 的静态模型才用 `tool_call`。**两个位置两种拼写**，已在那张表上方写明，别混。

> 另外两条它提的、核对后**不是缺陷**：① 模板 `checkin` 返回 `streak: r.streakDays` —— `streakDays` 是厂商字段，
> 返回给 magpie 的 key 仍是 `streak`，正确；② 「SCORING 的 D2 与 score.mjs 不一致」—— 它读到的是我改之前那一版，
> 现在两边都是「≥240 字符」。

### 保留意见（必须写明）

那个执行者与我是**同一个模型**（deepseek-v4.1），**不能代表「任何模型」**。
换弱模型要重测；重测方法见本节开头（只给它三份文档，不给提示）。

## 0.1.18 — 2026-10-28

**从「模板」变成「说明书」：官方 22 个锚点逐条可追，80 分能打分、能验**

这个仓库过去的问题不是内容少（3,700 行），是**没有一条结论标了官方出处**，
也没有一个「按什么顺序读」的主线，以及「80 分」只是一句话。三份新文件补上：

- **新增 [GUIDE.md](./GUIDE.md) —— 说明书主线。** 30 分钟、9 步：拿模板 → 改身份 → 写 `config` →
  写 `auth` → 写 `models` → 写 `usage`/`checkin` → 自检 → 打分 → 发布。**每一步都带官方锚点**
  （`#provider` / `#signin` / `#usage` / `#checkin` / `#test` / `#publish`），并指向本仓库里讲细节的那一节。
  第一次做插件从这份开始，不用再猜「先读哪个」。
- **新增 [OFFICIAL-SOURCES.md](./OFFICIAL-SOURCES.md) —— 官方引用索引。**
  官方中文文档 22 个锚点逐条映射到本仓库对应章节，标出「官方讲了的」与「官方没写、我们补的」。
  另列**增量清单 8 条**，每条都附「官方没写」的检查证据（`grep -c "rate === 0" provider-plugins.md` = 0 这种）。
  顶部写明引用基线（2026-10-28 / magpie 稳定版 0.1.1327 / `provider-plugins.md` 最后修改 `d4f1d648`）
  和 MIT 归属（Copyright (c) 2026 yetone）。
- **新增 [SCORING.md](./SCORING.md) + [scripts/score.mjs](./scripts/score.mjs) —— 80 分评分卡。**
  100 分 = A 合规 40 + B 测试 10 + C 语义 25 + D 说明书 15 + E 发布 10。
  另设**身份门**：`name` / `repository` / `registry-entry` / `const PROVIDER` / `const BASE` /
  「五个 TODO 还 throw 着」任一条不改，总分封顶 60 —— **克隆完一字不改本来就是 57 分，那是模板的分，不是你的插件的分**。
  `node scripts/score.mjs` 一条命令算自动分（A/B/D），C/E 标「待人工」并列出判据，**不许自报分数**。
- **[README](./README.md)** —— 「必读四份」改成「必读五份」，0 号是 GUIDE；目录加三份新文件
- **新增 [CONTRIBUTING.md](./CONTRIBUTING.md) —— 共创说明。** 定位（官方讲规则 / 我们讲后果）、三条纪律
  （每条结论带官方锚点、每处补充带判据、官方更新先改索引）、可贡献的五类、四道门，
  以及「和官方的关系」——**不请求收编，正确形态是 issue + 证据**（附 #392 先例）
- **[AGENTS](./AGENTS.md)** —— 「还没开工」那行改成先读 GUIDE；文档地图加三行
- **[package.json](./package.json)** —— `files` 加三份新文档，`scripts` 加 `score`

> 起因：主人定下方向 —— **不归并，改「邀请共创」**：官方只有指导性文件，我们做「基于官方指导文件的
> 脚手架说明书」。价值主张是「任何模型拿到脚手架就能做一个 80 分以上的 magpie 插件」。
> 这句话要成立，必须补三样东西：可追的官方出处、可走的主线、可验的分数。这一版就是这三样。
>
> **盲测已经做了**：把脚手架交给一个只读 `GUIDE.md` / `SCORING.md` / `AGENTS.md` 三份的执行者，
> 让它做虚构供应商 Nimbus 的插件。产出复跑结果（我自己跑的，不是它自报）：
> `check.mjs` **29 通过 · 0 警告 · 0 失败**、`score.mjs` **身份门通过 · 自动分 65/65**、
> `node --test` **18 通过 · 0 失败**。
> ⚠ 保留意见：那个执行者与我是同一个模型，**不能代表「任何模型」**；换模型（尤其弱模型）要重测。

## 0.1.17 — 2026-10-28

**「官方文档漏了 auth.checkin」已经过时了 —— 那条缺口在 2026-10-26 就被补上了，留着会打脸**

`auth.checkin` 确实曾不在官方文档里，2026-10-25 以 [magpie-community/plugins#392](https://github.com/magpie-community/plugins/issues/392) 报给社区，
yetone 当天回复（[magpie v0.1.1582 / commit `c28d3e8b0`](https://github.com/yetone/magpie/commit/c28d3e8b0)），en / zh / ja 三语补齐，issue 已关闭。
四处「官方漏了 `auth.checkin`」的说法因此全部失效：

- **[README](./README.md) 必读四份** —— 改成「官方讲行为、这份讲字段，两者并用」，并挂上那个缺口的故事
- **[README](./README.md)「一个曾经的缺口，已经补上」** —— 保留证据链（issue 号、commit、三语），并写明它为什么值得留：**拿证据指官方漏了什么，比说「我做了个东西」有用**
- **[HOOKS](./HOOKS.md) 开头** —— 不再声称「比官方全」，只声称「比官方细」（字段级 vs 行为级）
- **[AGENTS](./AGENTS.md) 文档地图** —— 同一句改正

顺带三处硬缺陷（都是对外的，不改会被人当场指出来）：

- **`package.json` 的 `repository` / `bugs` / `homepage` 还指着旧仓库名 `magpie-plugin-template`** —— 已改成 `magpie-plugin-scaffold`（旧名靠 GitHub 的 301 重定向活着，但链接显示的是错的名字）
- **[AGENTS](./AGENTS.md) 命令区的 `npm run publish:npm`** —— 这是**派生仓库自己加的**脚本，本模板 `package.json` 里没有，裸跑报 `Missing script`。已加限定语，并写明 `release.mjs` 会自动检测（有就用、没有退回 `npm publish`）

> 起因：讨论「要不要找 magpie 官方/社区合作或归并」。先去核了官方现状 —— yetone/magpie 24,439 star、
> `docs/subsystems/provider-plugins.md` 64,931 字节且**当天还在改**；`usemagpie.ai/docs/zh/plugins`
> 已有「五分钟写一个插件」的完整 quick start。结论是**归并没有路**（官方 PR 只对 collaborator 开放；
> registry 只收插件；社区 `skills/` 是维护者自留地），而**合作有路且已走通过 —— 形态是 issue**。
> 但这条路的第一步是：自己文档里不能有错的陈述。

## 0.1.16 — 2026-10-28

**判断「要不要跟着 magpie 升级」只看稳定渠道 —— 每版本渠道一晚四个，追它全是白跑**

magpie 设置里有「更新渠道：每个版本 / 稳定版」。把两个渠道的契约都提取出来对比：

| 渠道 | feed | 2026-10-28 的版本 | 契约段数 | 字符数 |
|---|---|---|---|---|
| 每版本 | `usemagpie.ai/api/latest` | **0.1.1763** | 23 | 264,822 |
| **稳定版** | `usemagpie.ai/api/latest?channel=stable` | **0.1.1327** | 21 | 201,045 |

差 400 多个版本，但**插件相关的字段一条不差**（`searches` / `decides` / `rateWas` /
`serviceTiers` / `modalities` / `capabilities` 两边都有）。多出的 2 段是 `summaries` /
`last seen`，属 GUI 历史，不是插件契约。

- **新增 [`scripts/check-magpie-stable.mjs`](./scripts/check-magpie-stable.mjs)** —— 一条命令判断该不该动：
  从 HOOKS.md 抓基线版本 → 查稳定渠道 → 比对。`0` = 不用动；`2` = 稳定版变了，并打印三步
  （下稳定版 → `extract-contract.py` → `contract-diff.mjs`）
- **[HOOKS](./HOOKS.md) 顶部基线改成 `0.1.1327`（stable）** —— 并附两渠道对比表，写明「看稳定渠道，不看每版本渠道」
- **[UPDATING](./UPDATING.md) 新增第七节** —— magpie 自己升级了什么时候该动文档、三步、以及「内嵌契约抓不到的部分」（供图判据、ID 白名单）
- **[AGENTS](./AGENTS.md) 坑表补第 21 条 + 命令** —— 「花一晚上追每版本，用户那边一点变化都没有」
- **四个插件仓库的 AGENTS 同步了这一节**（`magicrew-auth` / `officeace` / `loomy-auth` / `today`）

> 起因：主人指出 magpie 出了「稳定版」渠道。查证后确认：之前追 1763→1767 是追的每版本，
> 而稳定版是 0.1.1327 —— 追了 400 多个版本号，插件契约却没变过。

## 0.1.15 — 2026-10-28

**把「契约会不会落后」做成一条命令 —— 因为 0.1.14 那次是手工比对出来的**

0.1.14 补的 6 个字段是靠人眼对出来的，这不可靠：magpie 一晚上就发了 1764→1767 四个版本。
而且脚本第一次跑就抓到一条**我漏得更彻底的**：`capabilities` 这个词在 HOOKS.md 里
出现 **0 次** —— 模型条目的能力（reasoning / attachment / tool_call / modalities）全挂
在它下面，而原文没写这层结构。

- **新增 [`scripts/contract-diff.mjs`](./scripts/contract-diff.mjs)** —— 契约定时比对的自动化：
  `python extract-contract.py && node scripts/contract-diff.mjs`，自动列出「契约里有、
  HOOKS.md 一个字都没提」的字段，退出码 2 表示有差集。它只扫插件相关的段落
  （`one provider's hooks` 到 `the loop`），不切掉的话假阳性从 20 涨到 99
- **[HOOKS](./HOOKS.md)「十一之三」按 `capabilities` 重排** —— 拆成「顶层」与
  「`capabilities` 下面」两张表，并补 `apiId` / `released` / `family` / `temperature` /
  `interleaved` / `maxTokens` / `imageSaid` 七个字段
- **[AGENTS](./AGENTS.md) 命令区** —— 加「magpie 升级后必做：重新提取 + 跑 contract-diff」
- 顺带：`extract-contract.py` 的产物已进 `.gitignore`（264 KB，不进仓库）

> 起因：0.1.14 补完字段后意识到「下次 magpie 升级还是会漏」。脚本第一次跑出的差集是
> 30 个（限段落前）/ 99 个（全文件），补完这一轮降到 20 个，且剩下 20 个全是 GUI / tools /
> 内部变量，不是插件该写的 —— 这就是「差集收敛到噪声」的判据。

## 0.1.14 — 2026-10-28

**按 magpie 0.1.1763 重新提取契约：补 6 个漏掉的字段 + 插件供图；另补 store 骨架、拆分示例、双站点改造流程**

- **[HOOKS](./HOOKS.md) 新增「十一之三：模型条目上的全部字段」** —— 用 `extract-contract.py` 从 magpie **0.1.1763** 重新提取（23 段 / 258,708 字符），比对后发现原来漏了 6 个字段。它们全是「**不写就等于关掉某个能力**」，不会报错：`searches`（模型级=这条自己会搜，provider 级=上游整体会搜）、`decides`（decision 模型）、`rateWas`（折扣前倍率）、`fast`、`serviceTiers`、`modalities`（图片/音频能力全靠它）
- **[HOOKS](./HOOKS.md) 补「插件供图（`draw`）」** —— magpie **0.1.1707 起**支持插件提供图像模型（0.1.1747 接入 SenseNova `sensenova-u1.5-lite`）：id 命中 `catalog.DrawsID` 且 `catalog.ImagesAPI`、npm 是 `@ai-sdk/openai-compatible` → 进 Settings 的「图像生成」选择器，请求走 `/v1/images/generations`。⚠ 但它**同时留在 chat 模型列表里**，列不列是取舍
- **[`src/models.mjs`](./src/models.mjs) 新增 `LIST_IMAGE_MODELS` 开关（默认 `false`）** —— 原来 `NOT_CHAT` 一刀切把 `image` / `flux` / `sd` 全砍掉，等于默默放弃这个能力；现在把选择摆到明面上：想供图就打开，并且把 `capabilities.output` 写成 `{ text: false, image: true }`
- **新增 [`src/store.mjs`](./src/store.mjs)** —— 缓存三规矩（只写 `~/.cache/magpie`、文件名带账号、可整目录删）+ 原子写 + 快照/登录态/一次性标记三件套。这是四个插件里每个都重写过一遍的那部分
- **新增 [`examples/split/`](./examples/split/)** —— 「`index.mjs` 只装配」的实样：三个钩子各占一个文件（纯声明 / 异步取数 / 纯计算三种形态），index 缩到 40 行。钩子只有这三种形态，其余五个照同一规则搬
- **[MULTI-PROVIDER](./MULTI-PROVIDER.md) 新增「三之二、已经写成单例了，怎么改成两个」** —— 五步改造流程，每步带验证判据（`grep` 什么、`node -e` 验什么、装两站怎么测），外加三条「不要做的事」
- **[AGENTS](./AGENTS.md) 坑表补两条**（19 契约字段漏写 = 关能力、20 生图模型的列与不列），「长大之后」四块骨架齐了
- `extract-contract.py` 的产物 `magpie-plugin-contract-full.txt`（264 KB）加进 `.gitignore`

> 起因：主人问「magpie 更新了哪些、脚手架要不要同步」。查证：本机与上游都是 0.1.1763/1764；
> 最近 60 个版本里插件相关的实质变更只有供图（0.1.1707/1747）与 Serves chip（0.1.1744，已在 0.1.8 同步）。
> 真正的问题不在「新版加了什么」，而在**旧版就有、HOOKS 漏抄的 6 个字段** —— 重新提取才看见。

## 0.1.13 — 2026-10-28

**`release.mjs` 不再和 `release.yml` 抢着建 Release**

发现过程：0.1.11 那版脚本建 Release 报 `fetch failed`（0.1.12 修成 curl），
但 GitHub 上 `v0.1.11` 的 Release 还是出现了 —— 是仓库自带的 `release.yml` 被推 tag 触发、
自己建的。也就是说**有 workflow 的仓库里，脚本那一步是重复劳动**，谁先谁后还成了竞态
（后到的一方会 422）。

- [`scripts/release.mjs`](./scripts/release.mjs) — 有 `.github/workflows/release.yml` → 只推 tag，
  然后查一次确认（查到就报 `release.yml 已建`，没查到就提示「约 1 分钟后按第 ④ 条确认」）；
  没有 workflow → 先 `GET /releases/tags/<tag>` 查一次，已存在就跳过，避免重复建
- 顺带把「有 workflow 的仓库脚本别抢活」写进 [UPDATING](./UPDATING.md) 第 6 步那张三条路的表

## 0.1.12 — 2026-10-28

**修 0.1.11 的 `release.mjs`：建 Release 那一步改走系统 `curl`，不用 node 的 fetch**

0.1.11 自己发布时暴露的：`push` 和 `tag` 都成功，到建 Release 报 `fetch failed` ——
node 的 https 栈在本机打 `api.github.com` 走不通（证书链），而系统 `curl` 走 schannel 正常。
后果是「tag 有了、Release 没有」的半截状态，正是这个脚本想防的东西。

- [`scripts/release.mjs`](./scripts/release.mjs) —— 建 Release 改成 `execFileSync("curl", …)`，
  token 从环境变量进、正文走 stdin（`--data-binary @-`）；失败时把 curl 的 stderr 打出来，
  不再吞成一句 `fetch failed`
- 顺带留了注释说明为什么这一步**故意不用 fetch** —— 上次就是「文档里记着、代码里忘了」

## 0.1.11 — 2026-10-28

**读完四个真实插件之后补的四块东西 —— 都是「它们每个都重写了一遍」的部分**

比对了 `magicrew-auth` / `officeace` / `loomy-auth` / `today` 与模板的代码分布：
模板的 `src/` 只有 78 行，真实插件是 1,397~3,683 行；模板 `index.mjs` 535 行，
最成熟的那个（magicrew）只有 80 行。差的不是钩子，是**钩子下面那一层**。

- **新增 [`scripts/release.mjs`](./scripts/release.mjs)** —— 一键发布：体检六项（版本 / CHANGELOG 有该版本 / 工作区干净 / 在默认分支 / 不落后远端 / tag 未被占）→ push → tag → 建 Release，最后把第 7 步的四条验证命令打印出来。默认只预演，`--yes` 才动手；`--npm` 连 npm 一起发。**它故意不替你做第 0~3 步**（写 CHANGELOG / bump / pack 预演 / 提交）—— 那四步要人判断，而且体检会把它们当输入检查
- **新增 [`src/api.mjs`](./src/api.mjs)** —— `headersFor` / `read` / `get` / `asModelError` / `asSignInExpired`。四个插件 4/4 都有这个文件，因为**错误语义只该在一处定义**：401 是登录失效（整个账号停）、404 是模型不可用（只影响这次），混用一次就打死一个账号
- **新增 [`src/models.mjs`](./src/models.mjs)** —— `isUsable` / `priceOf` / `buildModels` / `defaultEntry`。把「部分成功三态」写成代码：整个接口失败 → 退回快照；接口成功但单条缺价格 → 不列；登录失效 → 抛 `signIn: "expired"`。`free` 按厂商声明三分支，不从 `rate` 反推
- **新增 [`src/chat.mjs`](./src/chat.mjs)** —— `passThrough` / `withUsage` / `singleShotToSSE` / `normalizeUsage`。流式三坑：不要读干流、流式必须带 `stream_options.include_usage`、magpie 不接受 `stream:false`
- **新增 [`tests/semantics.test.mjs`](./tests/semantics.test.mjs)** —— 16 条语义锁（`node --test tests/`）。`check.mjs` 查形状，这一份查语义：上面三块的错法全都「不报错」，只能靠它拦
- [AGENTS](./AGENTS.md) —— 坑表补 3 条（按账号落盘、三态降级、index 只装配），新增「五、长大之后：从单文件到 `src/`」：给出四个真实插件的 index/src/tests 实测行数，和「什么时候该搬」的判据
- [UPDATING](./UPDATING.md) —— 第 6 步改成三条路（`release.mjs` / workflow / 手工）并给「什么时候该有 `release.yml`」的判据；「四、更新内容怎么写」补一条：每个版本末尾用 `> 起因：` 记为什么（它不进 Release 正文）

> 起因：读完四个真实插件后的对比。通用件不是钩子，是 `api` / `models` / `chat` 这三个文件
> 加一份语义测试 —— 四个仓库里每一个都独立重写了一遍，而且每一份都踩过同样的坑。

## 0.1.10 — 2026-10-28

- **新增 [AGENTS.md](./AGENTS.md)** —— 给 AI 执行者的入口：按「你在哪一步」给阅读顺序（开工 / 写钩子 / 交付 / 发版 / 用户说没更新），外加 15 条会静默出错的坑（症状 → 判据 → 出处）。派生仓库直接带走
- **新增 [CHECKLIST.md](./CHECKLIST.md)** —— 两张勾选表：A 表代码交付前 13 项（`check.mjs` 查不到的：钩子语义、`usage.used`、`free` 不从 rate 反推、上下文窗口实测、404 vs 401…），B 表发版前七步带命令与判据
- [README](./README.md) —— 「动手前先读这三份」改成**「必读四份」**，第四份是 `UPDATING.md`：它原来只出现在下面「目录」里，读完前三份就去写代码的人会漏掉发布
- [README](./README.md) —— 开头补一句：`git push` 只是发布七步里的第 4 步；「之后每一次更新」里的「六步」改正成**七步**（原来漏了 `npm pack --dry-run` 与 tag/Release 的完整对应）
- [UPDATING](./UPDATING.md) —— 开头加「不读这份的后果（真发生过）」：push 完所有命令都不报错，但 npm 上是旧版本、GitHub 写着「暂无发布版本」
- [README-TEMPLATE](./README-TEMPLATE.md) —— 「仓库里还该有什么」补 `AGENTS.md` / `CHECKLIST.md` 两行，并写明为什么这两份对 AI 执行者尤其重要
- [scripts/check.mjs](./scripts/check.mjs) —— 末尾输出加两行：把「脚本查不到的」指到 `CHECKLIST.md` 的 A / B 表。脚本绿了 ≠ 能发布

> 起因：`magpie-magicrew-auth` 0.3.14 发布时**只 push 没发 npm、没打 tag、没建 Release**，
> 而当时确实读过 README。根因不是「不知道有 `UPDATING.md`」，是它没进阅读路径 ——
> README 顶部的必读清单只有三份。整理目标是：**任何 AI 从这个仓库的任何入口进来，
> 都能在几分钟内知道「发布是七步，push 只是第 4 步」。**

## 0.1.9 — 2026-10-27

- **删掉 `src/self-register.mjs`** —— 插件不再往 `~/.cache/magpie/plugin-market.json` 写条目：那是 magpie 的文件，按包名 merge 会把 registry 条目盖掉（上游 review `magpie-community/plugins#399` 明确要求删）
- **新增 `registry-entry.json`** —— 要提交给 `registry.json` 的条目形状摆在这里，改四个字段即可
- [README](./README.md) —— 「卡片上的许可证和『源码』按钮」整节重写：载体是 registry 条目，不是本地缓存；「方式三」那段的「用自注册绕开审核」删掉
- [scripts/check.mjs](./scripts/check.mjs) —— ⑩ 从「读 index.mjs 里的 `REGISTRY_ENTRY`」改成「读 `registry-entry.json`」，另加一条静态检查：入口与 `src/` 里不准出现 `plugin-market.json` / `startSelfRegister`
- [README](./README.md)、[README-TEMPLATE](./README-TEMPLATE.md)、[UPDATING](./UPDATING.md)、[HOOKS](./HOOKS.md) —— 四处提到 `REGISTRY_ENTRY` 的地方跟着改

> 起因：OfficeAce 那份 PR 的 review。结论是插件对 magpie 的目录**只有读的份** —— 想改卡片上看到的东西，只能改 registry 条目。

## 0.1.8 — 2026-10-27

- [MULTI-PROVIDER](./MULTI-PROVIDER.md) —— 铁律 6 重写：卡片上那个「承载 X、Y」**不是 package.json 字段**，magpie ≥ 0.1.1744（`766356c`，issue #3902）从插件**注册的 provider 名**派生；草案里的 `magpie.carries` 从未随任何 magpie 发布。附「什么时候出现」与「名字带不带站点」的判据
- [HOOKS](./HOOKS.md) —— 九之三原来断言「第三方插件挣不到这个徽章」，改成派生规则：`servesBeside` 的四条行为、`moved` 与 `serves` 怎么拼成一个 chip、tooltip 只留给 `moved`
- [README](./README.md) —— 「数据字段」表那一行改成「没有字段」；会过期的「24 项规定」换成脚本自己报的总数
- [scripts/check.mjs](./scripts/check.mjs) —— 撤掉 `magpie.carries` 的 4 条形状检查，换成 1 条：写了这个已作废的字段就警告，提示删掉

> 起因：issue #3902。上游没走「包里自己声明」（option 1），选了「从注册的 provider 派生」（option 2）。
> 本仓库按 option 1 写的草稿（PR #1）随之作废；这一版记录的是上游**实际发布**的行为。
> 实测环境：magpie v0.1.1744 + windows/amd64 + magpie-magicrew-auth 0.3.8 的文件夹安装。

## 0.1.7 — 2026-10-27

- [README-TEMPLATE](./README-TEMPLATE.md) —— **模型段改版**：开头写发行商（`DeepSeek / GLM / GPT`），不写「支持 N 个模型」；表格只留各家最新 / 热门一两行，全量交给 `magpie plugin list`
- [README-TEMPLATE](./README-TEMPLATE.md) —— 硬规则加第 8 条（发行商而非数量）；反例对照补「模型数量」与「整表贴满」两行；「完整实例」注明 loomy 的模型段是旧写法，以本模板为准
- [README](./README.md) —— 「写 README」摘要同步这条规则；「README.md 写清四件事」把「有哪些模型」改成「支持哪几家发行商」
- [HOOKS](./HOOKS.md) 第十节 —— 「README 写清四件事」第 4 条改成「支持哪几家发行商，各家只列最新 / 热门」，并写明别写「支持 N 个模型」的理由

## 0.1.6 — 2026-10-27

- **分清三个名字**（这是个真混淆过的地方）：`package.json` 的 `name` → 插件卡片标题；
  `config.provider[id].name` → 供应商列表那一行；`REGISTRY_ENTRY.name` → 市场条目显示名，**不是**卡片标题；
  仓库名只进链接
- [HOOKS](./HOOKS.md) 九之二 —— 加「先把三个名字分清」对照表 + `magpie-magicrew-auth` 的实例
- [MULTI-PROVIDER](./MULTI-PROVIDER.md) / [README](./README.md) —— 改正两处把供应商名写成「卡片标题」的注释

## 0.1.5 — 2026-10-27

- **图标规则落实成代码**，不再只躺在文档里：模板 `package.json` 的 `magpie.icon` 直接带一份可用的 data URI，`index.mjs` 的 `auth.icon` 用同一份，并在注释里写明「两处各管一个位置，缺一份就有灰方块」
- [HOOKS](./HOOKS.md) —— 新增「插件自己的图标：`magpie.icon`」：`iconOf` 管供应商卡片，`InstalledIcon` 只管**插件卡片**，`auth.icon` 到不了后者；附源码与「只写一处会灰在哪」的对照表
- [HOOKS](./HOOKS.md) —— 新增「九之三、卡片上的徽章从哪来」：`供应商 / Request hook / 中间件 / 页面` 是插件挣得到的，**`承载 {names}` 挣不到** —— `provider.MovedOnto` 只遍历 magpie 自己的内置订阅（当前 19 个），不在清单里的产品永远返回空。附源码，避免下一个人再去试
- 遵守[最小交付面](./README.md#最小交付面)：只对齐声明，不加脚本、不加钩子、不碰运行时

## 0.1.4 — 2026-10-27

- **新增 [MULTI-PROVIDER.md](./MULTI-PROVIDER.md)** —— 单插件多供应商：magpie 认「具名导出」的机制、`makePlugin(SITE)` 骨架、五条铁律（provider id 不改 / `auth` 里不存站点 / 图标名字要分开 / 站点差异集中声明 / 未登录别给假模型）、模型目录改用快照 + 实时拉、反例对照、验证清单、registry 登记
- [README](./README.md) —— 「动手前先读这两份」改成三份，目录加「单插件多供应商」一行
- [HOOKS](./HOOKS.md) —— 开头补一条指向 MULTI-PROVIDER.md：多供应商时 `auth` 里不能再存站点字段
- 参考实现：[MYCF711/magpie-magicrew-auth](https://github.com/MYCF711/magpie-magicrew-auth)（两站）、`opencode-workbuddy-auth`（两站）、`opencode-qoder-auth`（四站）

## 0.1.3 — 2026-10-26

- **新增 [UPDATING.md](./UPDATING.md)** —— 更新途径：magpie 的两条检测路径（npm 源比 `version`、git 源比默认分支 HEAD 的 commit）、发版六步、CHANGELOG 规矩、发版前清单
- **新增本文件** —— 更新记录从这一版起逐条记
- [README](./README.md) —— 目录与「怎么发布」指向 UPDATING.md
- [README-TEMPLATE](./README-TEMPLATE.md) —— 文件清单加 `CHANGELOG.md`，骨架末尾加一行更新记录路标
- [HOOKS](./HOOKS.md) —— 新增「九之二、插件名」：卡片标题来自 `plugins/package.json` 的依赖键名（附 `plugin.Name()` 源码、改名三步、以及 `add` / `update` 会覆盖手改键名这条陷阱）
- [HOOKS](./HOOKS.md) —— 「卡片上的其他文字来自哪」补上「版本后面那串 = 已装 commit 短 sha（只有 git 源有）」，并说明它同时解释了 git 源为什么按 commit 判断更新
- **新增 [.github/workflows/release.yml](./.github/workflows/release.yml)** —— 推 `v*` tag 就用仓库自己的 token 把本文件里该版本的条目建成 GitHub Release（正文与 CHANGELOG 同源）
- **UPDATING.md 补「卡片标题」一节** —— **在仓库里改 `name` 才是正路**，`add` / `update` 都不会重置；手改依赖键只是已发布插件的兜底（三处同步：`package.json` / `bun.lock` / `node_modules`）
- [UPDATING.md](./UPDATING.md) —— 再补一节「git 源想要大写标题、npm 又要能发」：发布时用脚本临时换 `name`（实测：打包出来是小写包名，跑完自动还原），两个来源各得其所、npm 那边包名不变
- [UPDATING.md](./UPDATING.md) —— 补上这条路的**端到端实测**：改 `name` 后 `plugin rm` + `add`，全程不碰文件，装出来的依赖键就是 `OfficeAce`，`bun.lock` 的值首段也变成包名（officeace / loomy 各验一次）
- [README](./README.md) —— 「怎么发布 → npm」原来只写裸跑 `npm publish`，补上「显示名与包名不同的插件走 `npm run publish:npm`」；[README-TEMPLATE](./README-TEMPLATE.md) 的安装骨架与 [HOOKS](./HOOKS.md) 的改名说明同步改掉过时说法
- `package.json` —— `files` 带上 `UPDATING.md` 与 `CHANGELOG.md`

## 0.1.2 及更早

早于本文件的引入，记录见 `git log --oneline`。
