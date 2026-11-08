# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。
>
> 本仓库派生自 [magpie 插件脚手架](https://github.com/MYCF711/magpie-plugin-scaffold)（模板历史停在 0.3.12），
> 插件自己的版本从 0.1.0 起算。

## 0.1.1 — 2026-11-08

**签到对齐 deepseek-harness-codearts 的 zcode 领取语义（只对齐语义，不产 captcha）**

- **3012 账号级风控必须短路**：命中后不再发剩余 plan，也不给 `until` 让 magpie 重试 —— 连续重试会把 30 分钟冷却推成 24 小时甚至停用（参考实现 Gitee issue IKJOQB）
- **营销回执（confirm）**：领取成功（code 0 或 1003 已领取）且 plan 带 campaign id 时回执一次，否则服务端每轮都把同一条 campaign 再投放一遍、为一个已领的 plan 反复要验证
- **补活跃上报**：列 plan 前先报 `app_launch` / `app_daily_active`；上报失败只降级，不让整个签到变 failed
- **preview + marketing/touch 合并**：preview 主路径、营销 feed 补充，按 plan id 去重；单源失败只降级、两源都读不到才 failed（卡片那行仍只读 feed）
- **没 plan 的文案**改成「今日暂无可领额度（服务端按日刷新）」；outcome 词表不变（仍是 inactive + 半小时后重问）
- 顺手修 `claimOne` 里未 import 的 `anyDevice`（device 为空时会静默变成 failed）

## 0.1.0 — 2026-11-08

**首个版本：ZCode 的 GLM Coding Plan，按 magpie 插件架构重写**

- 登录：ZCode 的 OAuth 流程（Z.ai / BigModel 智谱）、团队席位（`zcode-team-api-key`）、
  ZCode App 自己的登录态（读 `~/.zcode/v2/credentials.json`，含 3.14 的「数据存储路径」、
  3.15 的 `config.json` 密钥、3.16 的 `project-key-location`），以及直接粘 API key
- 请求路由：有 Coding Plan 走 `api.z.ai/api/anthropic` 或 `open.bigmodel.cn/api/anthropic`；
  没有就走 zcode.z.ai 的免费 Start Plan（请求按 ZCode 自己的形状整形：三段 system、
  当天 `<system-reminder>`、`metadata.user_id`、`x-query-id`、`x-session-id`）；
  两者都有时按「优先用免费额度」把普通模型先花在赠送额度上，被拒再回落到计划
- 额度卡片：Coding Plan 的 5 小时 / 周窗口与套餐、团队席位的窗口、Start Plan 的 bucket
  与未开始计划，MCP 月调用数作为脚注；时间统一转 ISO
- 每日领取：ZCode 营销 feed 里投放的赠送计划由插件代领（1003 已领、3007 要 App 验证码、
  3002 限流时按厂商的等待时间挂起，不空转）
- 并发：Start Plan 每账号 3 个在飞请求排队；被 3008/3009/3010 拒时按 ZCode 客户端
  1s、2s 重试；连续被拒则整台机器暂停 3 分钟，避免 IP 被防火墙 405
- 模型目录：读 ZCode 自己的 provider 配置（在线 `client/configs` 与已安装 ZCode 的
  `zcode-builtin.json` 取 revision 新的那份），赠送额度模型以 `-Trial` 条目出现
- 架构：`index.mjs` 只做九项钩子的装配，实现全部在 `src/`（按域拆成
  zcode / zai-call / keys / signin / own / session / plan / gift / allowance / claim /
  catalog / start / concurrency / answer / loader / prompt 十六个模块）；
  上游 `bun:test` 套件原样移植到 `node --test`（`tests/support/` 提供兼容层）
