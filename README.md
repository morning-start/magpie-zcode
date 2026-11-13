# 智谱 ZCode for magpie

像 ZCode 自己那样登录 Z.ai / 智谱的 **GLM Coding Plan**，把 GLM 模型按 Anthropic Messages 形状接进 magpie。Provider id：`zcode`。

```text
4 种登录方式  ·  Coding Plan / 团队席位 / 免费 Start Plan 三条通道
5 小时 / 周窗口  ·  签到自动过阿里云验证码  ·  模型跟随 ZCode 官方目录
```

---

## 功能

- **登录** —— ZCode 的 OAuth（浏览器里签 Z.ai 或智谱）、团队席位、跟随本机 ZCode App 的登录态、直接粘 API key：四种任选。
- **路由** —— 账号有 Coding Plan 就用它；没有就找团队席位；再没有就用 ZCode 的免费 **Start Plan**。
- **额度卡片** —— Coding Plan 的 5 小时 / 周窗口、套餐与续费、还能重置几次；团队席位与 Start Plan 的 bucket 各自成窗口。
- **每日领取** —— 自动领 ZCode 的赠送计划（preview + 营销 feed 合并去重），领取前的阿里云**无感验证由受控浏览器自动过**。
- **模型目录** —— 读 ZCode 自己的 provider 配置；`-Trial` 条目就是赠送额度的模型；登录失效时退回静态表，卡片不会空。
- **并发与退避** —— Start Plan 每账号 3 个在飞请求；被拒按 ZCode 客户端的节奏重试；整机被防火墙盯上时暂停 3 分钟。

---

## 模型

**智谱 / Z.ai 的 GLM 系列** —— 登录后跟随 ZCode 官方配置上下架。下表是没登录时的静态兜底：

| 代表模型 | 上下文 | 输出 | 思考档 | 说明 |
|---|---|---|---|---|
| `GLM-5.3` | 1,000,000 | 128,000 | low / high / max | 旗舰；**Start Plan 不给这个** |
| `GLM-5.3-Flash` | 1,000,000 | 128,000 | low / high / max | 快速档 |
| `GLM-5.2` | 1,000,000 | 128,000 | none / high / max | 热门 |
| `GLM-5-Turbo` | 200,000 | 64,000 | none / high | 热门 |
| `<模型>-Trial` | 同上 | 同上 | 同上 | 赠送额度服务；选择器里就是「用赠送额度」 |

> 只列代表。模型目录随时上下架，全量以装好后的 `magpie plugin list` 为准。

---

## 每日领取

`auth.checkin` 领 ZCode 的赠送计划：`billing/preview` 的每日赠送 + 营销 feed（`/api/v1/marketing/touch`）里投放的活动，按 plan id 合并去重，领到后给营销活动回执。

ZCode 的领取被阿里云验证码守着。插件照 ZCode 客户端自己的做法过这一关：开一个屏幕外的受控 Chromium（**真窗口**，不是 headless——无感验证看指纹），页面载入阿里云官方 SDK 跑无感验证，把 `captchaVerifyParam` 放进 `X-Aliyun-Captcha-Verify-Param` 再领。解不出（机器上没有 Chromium、无感要人工、45 秒超时）才退回 `captcha`，让用户去 ZCode App 手动领。

| outcome | 含义 |
|---|---|
| `claimed` | 刚领到 |
| `done` | 今天已经领过（1003） |
| `inactive` | 现在没有可领的计划，半小时后再问（计划常在白天才投放） |
| `captcha` | 安全验证过不去（没有可用浏览器 / 要人工），去 ZCode App 里领 |
| `ineligible` | 这个计划此刻不对这个账号开放（1004），或今日名额已用完（1005，按 `data.plan.ends_at` 再问） |
| `failed` | 读不到或限流（3002）：按厂商的 `Retry-After` 挂起（没有就从 30 分钟翻倍，最多 6 小时） |

---

## 登录方式

| 方式 | 适合谁 |
|---|---|
| **ZCode: Z.ai GLM Coding Plan** / **ZCode: BigModel (智谱) GLM Coding Plan** | 有个人 Coding Plan；浏览器里签一次，插件自动建 `zcode-api-key` |
| **ZCode: a team's GLM Coding Plan** | 只有团队席位（ZCode 里团队计划和个人计划是并列两项） |
| **ZCode app's sign-in** | 本机装了 ZCode App；插件跟着它的登录态走，App 换号插件跟着变 |
| **GLM Coding Plan API key** | 手上已有 `<id>.<secret>` 的 key，直接粘，选 Z.ai 还是智谱 |

---

## 安装

> 插件还没发 npm，magpie 的「发现」里搜不到 —— 走下面的 git 源安装。

### 命令行

```bash
# 从仓库源码（推荐，跟随 main）
magpie plugin add github:morning-start/magpie-zcode

# 指定版本
magpie plugin add github:morning-start/magpie-zcode#v0.1.2
```

装完确认：

```bash
magpie plugin list
# 智谱 ZCode  on
#   zcode (智谱 ZCode, N models)  signed in as <账号>
```

⚠ 改了代码要 **bump `version`** 再打包 —— 同一版本号重打，bun 会命中缓存（输出 `no changes`）。

---

## 常见问题

**登录后额度卡片是空的？** 先看账号有没有计划：没有 Coding Plan 也没有团队席位时，卡片只列 Start Plan 的 bucket；ZCode 会话过期会在卡上说明原因。

**为什么 Start Plan 看不到 `GLM-5.3`？** ZCode 的免费通道只给 `GLM-5.3-Flash`、`GLM-5.2`、`GLM-5-Turbo`。要旗舰模型需要 Coding Plan。

**签到一直失败？** 先看错误码：`Unauthorized` 是登录态过期（重新登录）；`3007` 是验证码，插件会自动过，机器上没有 Chromium 才退回 `captcha`；`3002` 是限流，等 `Retry-After` 即可。

**模型比 ZCode 客户端里少？** 插件读 ZCode 自己的 provider 配置，没登录时用静态表兜底；登录后两边应该一致，不一致多半是 ZCode 那边还没刷新目录。

**和 ZCode 客户端同时登录会互相影响吗？** 不会。插件用自己的 device id 和登录态，互不覆盖；但同一账号的领取是幂等的，谁先领谁生效。

**为什么要开浏览器？** 领取前的阿里云无感验证只能在浏览器里跑。插件开的是屏幕外的一次性窗口，跑完就关、profile 立刻删除；全程串行，多账号不会同时弹一堆。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [pjpv/zcode-switch](https://github.com/pjpv/zcode-switch)（MIT） | 领取链路（preview / claim / `X-Aliyun-Captcha-Verify-*` 头）、失败码语义、`1005` 的 `ends_at` |
| [iJetLi/deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts) | 签到合并去重、活跃上报、营销回执 |
| ZCode 客户端 / [magpie 插件脚手架](https://github.com/MYCF711/magpie-plugin-scaffold) | 模型目录、额度窗口与九项钩子契约 |

完整的版权声明与逐段出处见 [NOTICE.md](./NOTICE.md)。

---

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)

## 许可

MIT。
