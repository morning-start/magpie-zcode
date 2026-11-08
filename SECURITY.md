# 安全策略 / Security Policy

## 支持范围

| 版本 | 是否接受安全报告 |
|---|---|
| 最新 Release（见 [Releases](https://github.com/MYCF711/magpie-plugin-scaffold/releases)） | ✅ |
| 上一个 minor 的最新 patch | ✅ |
| 更早的版本 | ❌ 请先升级 |

本仓库是**插件模板 + 规范文档**，本身不含服务端、不收集用户数据。
但从这里派生出去的插件会持有第三方站点的登录态与 token，所以下面这些**派生插件**的问题也算本仓库的问题：

- 模板的 `src/` 通用模块（`credential` / `store` / `refresh-lock` / `oauth-*` / `http` / `openai-sse`）里的凭据泄露、日志脱敏缺失、并发刷新竞态、SSRF、原型污染；
- 模板的 `scripts/` 里的发布链路（`release` / `publish-npm` / `privacy-scan`）的供应链风险；
- 文档里给出的**错误示范**（照着 `HOOKS.md` / `README.md` 写会写出漏洞的那种）。

## 怎么报

**首选**：用 GitHub 的私密报告入口 ——
<https://github.com/MYCF711/magpie-plugin-scaffold/security/advisories/new>

（仓库 Settings → Code security → Private vulnerability reporting 需开启；开着的话这个链接直接可用。）

**其次**：发邮件到 `security@example.com` ← **请替换成你自己的邮箱再发布本文件**。

**不要**用公开 issue 报安全问题。公开 issue 里贴 PoC，等于先教别人怎么打。

## 写什么

一条能复现的报告至少要有：

1. 受影响的文件与行号（或 `git rev-parse HEAD` 的提交号）；
2. 触发条件 —— 什么情况下会被利用，需要什么前提（能开插件 / 能读到本地文件 / 只是普通用户）；
3. 影响 —— 能拿到什么（凭据 / 任意请求 / 拒绝服务）；
4. 最小复现 —— 一段能跑的代码，或一条能执行的命令；
5. 你希望的披露时间（不填按下面第 3 条）。

## 我们承诺什么

| 阶段 | 时限 |
|---|---|
| 首次回复（确认收到、给一个带编号的处置计划） | 3 个工作日内 |
| 定级与修复方案（或明确说「不修」+ 理由） | 15 个工作日内 |
| 修复发布 | 高危 30 天内，中低危随下一个常规版本 |

修复发布后，在 `CHANGELOG.md` 里记一条（**不写细节**，写「修复一个安全缺陷，细节见 GHSA-xxxx」），并在 Release notes 里链接 Security Advisory。

## 我们不会做什么

- 不会要求你先签 NDA 才回话；
- 不会因为报告写得糙就拒收 —— 描述清影响就够了，格式我们替你补；
- 不会把「你自己改配置改错了」算成安全漏洞。

## 衍生插件维护者请注意

如果你是从本模板派生的插件作者：**派生仓库默认没有这份文件**。请把本文件一起带走，把邮箱换成你的，把「支持范围」改成你的版本号。派生插件普遍持有第三方登录态 —— 没有漏洞报告渠道，等于出事时用户只能发公开 issue。

---

更新时间：2026-11-04 · 本文件随 `CONTRIBUTING.md` 的同一条纪律维护：改规矩时同步改这里。
