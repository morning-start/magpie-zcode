// src/captcha.mjs —— ZCode 领取的安全验证（阿里云无感验证）
//
// ZCode 的 /api/v1/zcode-plan/billing/claim 被阿里云验证码守着：请求头里没有
// X-Aliyun-Captcha-Verify-Param 就回 3007 captcha verify failed。ZCode 客户端
// （以及 zcode-switch 1.7.x）的做法是开一个隐藏 WebView，跑阿里云 SDK 的
// startTracelessVerification()，把回调里的 captchaVerifyParam 塞进那个头。
//
// 插件没有 WebView，就用受控 Chromium 复刻同一条路：
//   ① GET /api/v1/client/configs → data.configs.captcha 给 sceneId / region / prefix
//   ② 在 127.0.0.1 起一个临时 HTTP 服务，页面里载入阿里云 SDK 并 init 无感验证
//   ③ 无感通过后页面把参数 POST 回来；服务关掉、浏览器退出、一次性 profile 删除
//
// 三条边界（写错会静默失败）：
//   · 只跑无感（startTracelessVerification）。8 秒没通过就算失败 —— 签到是后台跑的，
//     没有人会来点「点击完成验证」，所以**绝不**退化成弹按钮等人；
//   · 找不到浏览器 / 无感被风控 / 超时，一律抛错，由 claimDaily 退回 captcha 结果
//     （magpie 契约里 captcha 的含义就是「让用户去官方 App 手动签」）；
//   · 全局串行：多账号同时签到只开一个浏览器，不会一次弹出五个。
//
// 为什么浏览器要开在屏幕外而不是 --headless：阿里云的无感验证会看浏览器指纹，
// 纯 headless 容易被判成机器人直接要人工验证；zcode-switch 用的也是「真窗口、
// 藏起来」。需要无头时用 MAGPIE_ZCODE_CAPTCHA_HEADLESS=1 显式打开。

import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findBrowser } from "./browser-login.mjs"

// SDK_URL 是阿里云验证码前端的官方地址；ZCode 的 scene 就绑在这个 SDK 上。
export const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"
// TRACELESS_MS 是无感验证的等待上限：过了就说明它要人工，直接算失败。
export const TRACELESS_MS = 8000
// DEFAULT_TIMEOUT_MS 是整个解法的上限（含浏览器启动与页面加载）。
export const DEFAULT_TIMEOUT_MS = 45_000
// MAX_PARAM 是回传参数的长度上限（正常是一段 JWT 形态的串，远小于此）。
const MAX_PARAM = 16_384

/**
 * captchaOf 把 /api/v1/client/configs 的回复读成验证码配置。
 *
 * 三种结果，对应调用方的三条分支：
 *   · 没有 captcha 段 → `{ enabled: false }`：这家不查验证码，领取不带那个头；
 *   · 有对象 → `{ enabled, region, prefix, sceneId }`：enabled 为真才需要解；
 *   · 有但不是对象（数组 / 字符串）→ `null`：读不懂 = 未知，不能当「不用验证」。
 *
 * @param {unknown} configs clientConfigs() 的返回值（`data` 那一层）
 * @returns {{enabled:boolean, region:string, prefix:string, sceneId:string}|null}
 */
export function captchaOf(configs) {
  const c = configs?.configs?.captcha
  if (c == null) return { enabled: false, region: "", prefix: "", sceneId: "" }
  if (typeof c !== "object" || Array.isArray(c)) return null
  const str = (v) => (typeof v === "string" ? v.trim() : "")
  // 服务端两种写法都出现过（camelCase 是 ZCode 渲染进程读的那份）
  return {
    enabled: c.enabled !== false,
    region: str(c.region),
    prefix: str(c.prefix),
    sceneId: str(c.sceneId ?? c.scene_id),
  }
}

/**
 * captchaPage 是那个一次性页面：载入阿里云 SDK，跑无感验证，把参数 POST 回来。
 *
 * 页面完全受本模块控制（由本地服务发出），除了阿里云 SDK 不加载任何第三方脚本。
 * 参数用 JSON.stringify 注入，避免 scene/region 里的引号把脚本打断。
 *
 * @param {{sceneId:string, region?:string, prefix?:string, sdk?:string, tracelessMs?:number}} o
 * @returns {string}
 */
export function captchaPage({ sceneId, region = "", prefix = "", sdk = SDK_URL, tracelessMs = TRACELESS_MS }) {
  const j = (v) => JSON.stringify(String(v ?? ""))
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>ZCode · 安全验证</title>
<style>
  html, body { margin: 0; background: #0a0a0c; color: #9aa0aa; font: 13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  #hint { padding: 18px 20px 8px; }
</style>
</head>
<body>
<div id="hint">正在完成 ZCode 的安全验证…</div>
<div id="holder"></div>
<button id="btn" type="button" hidden></button>
<script>
  var SCENE = ${j(sceneId)}, REGION = ${j(region)}, PREFIX = ${j(prefix)}, TRACELESS_MS = ${Number(tracelessMs) || TRACELESS_MS};
  var settled = false;
  // sendBeacon 而不是 fetch：这是一次「送到就行」的回传（页面不等回应），
  // 同源不受 CORS 影响，而且这个模块自己不向上游发请求 —— 打阿里云的是浏览器。
  function post(path, text) {
    if (settled) return;
    settled = true;
    try { navigator.sendBeacon(path, String(text == null ? "" : text)) } catch (e) {}
  }
  function ok(param) {
    post("/param", typeof param === "string" ? param : (param && param.captchaVerifyParam) || "");
  }
  function fail(why) {
    post("/fail", typeof why === "string" ? why : JSON.stringify(why || "failed"));
  }
  window.addEventListener("error", function (e) { fail(e && e.message ? e.message : "script-error") });
  window.AliyunCaptchaConfig = { region: REGION, prefix: PREFIX };
  function start() {
    try {
      initAliyunCaptcha({
        SceneId: SCENE,
        mode: "popup",
        language: "zh-CN",
        showErrorTip: false,
        element: "#holder",
        button: "#btn",
        getInstance: function (instance) {
          if (instance && typeof instance.startTracelessVerification === "function") {
            instance.startTracelessVerification();
            setTimeout(function () { fail("interactive") }, TRACELESS_MS);
          } else {
            fail("no-traceless");
          }
        },
        success: ok,
        fail: fail,
        onError: fail,
      });
    } catch (e) {
      fail(e && e.message ? e.message : String(e));
    }
  }
</script>
<script src="${sdk}" onload="start()" onerror="fail('sdk-failed')"></script>
</body>
</html>`
}

/**
 * listen 起一个只服务这个页面的临时服务，返回端口与「参数到了」的 Promise。
 *
 * 只认 POST /param（成功）和 POST /fail（失败）；别的 GET 一律回页面。
 * 超时、请求被 abort、服务自己出错，都让 Promise 拒绝。
 *
 * @param {string} page
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [o]
 * @returns {Promise<{port:number, param:Promise<string>, close:() => void}>}
 */
export function listen(page, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settle = null
    const param = new Promise((res, rej) => { settle = { res, rej } })
    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(page)
        return
      }
      let body = ""
      req.setEncoding("utf8")
      req.on("data", (chunk) => {
        body += chunk
        if (body.length > MAX_PARAM) req.destroy()
      })
      req.on("end", () => {
        res.writeHead(204)
        res.end()
        const text = body.trim()
        if (req.url === "/param" && text) settle.res(text)
        else settle.rej(new Error(text || "captcha verification failed"))
      })
    })
    const timer = setTimeout(() => settle.rej(new Error("captcha verification timed out")), timeoutMs)
    const abort = () => settle.rej(new Error("captcha verification aborted"))
    signal?.addEventListener?.("abort", abort, { once: true })
    server.on("error", (e) => settle.rej(e))
    const close = () => {
      clearTimeout(timer)
      try { signal?.removeEventListener?.("abort", abort) } catch {}
      try { server.close() } catch {}
    }
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({ port, param, close })
    })
  })
}

/**
 * killTree 杀掉浏览器整棵进程树，再按 profile 路径扫一遍。
 *
 * Windows 上 Chrome / Edge 的启动器会 re-exec 之后自己退出：spawn 拿到的 pid
 * 可能已经不在了，而真正的浏览器（带着 --user-data-dir=<profile> 的那串子进程）
 * 还在跑。只按 pid 杀会漏（实测 5 个 profile 残留、Chrome 还挂着），profile
 * 目录也因此删不掉。所以按 pid 杀完，再按命令行里的 profile 路径扫一次。
 */
function killTree(child, profile = "") {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child?.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 })
    } else {
      child?.kill?.("SIGKILL")
      return
    }
  } catch {
    try { child?.kill?.() } catch {}
  }
  if (process.platform !== "win32" || !profile) return
  try {
    const quoted = profile.replace(/'/g, "''")
    execFileSync("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe' OR Name='chromium.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${quoted}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: "ignore", timeout: 15_000 })
  } catch {}
}

/**
 * sweepProfiles 清掉以前失败的残留：浏览器没杀干净时 profile 删不掉，会一直
 * 躺在 %TEMP% 里（每个几十 MB 的缓存）。默认只清两小时前的，不碰正在跑的。
 *
 * @param {{olderThanMs?:number, now?:number}} [o]
 * @returns {number} 清掉的目录数
 */
export function sweepProfiles({ olderThanMs = 2 * 3600_000, now = Date.now() } = {}) {
  let removed = 0
  try {
    const root = tmpdir()
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith("magpie-zcode-captcha-")) continue
      const dir = join(root, e.name)
      try {
        if (now - statSync(dir).mtimeMs < olderThanMs) continue
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        removed++
      } catch {}
    }
  } catch {}
  return removed
}

/**
 * solveCaptcha 跑一次无感验证，返回可以放进 claim 请求头的参数。
 *
 * 失败一律抛错（没有浏览器、页面载入不到 SDK、无感要人工、超时、被 abort），
 * 由调用方决定怎么降级 —— 本模块不猜「大概能过」。
 *
 * @param {object} o
 * @param {string} o.sceneId 阿里云场景 id（来自 client/configs）
 * @param {string} [o.region]
 * @param {string} [o.prefix]
 * @param {number} [o.timeoutMs]
 * @param {{name:string,path:string}|null} [o.browser] findBrowser() 的结果；测试可注入
 * @param {typeof spawn} [o.spawn]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{param:string, region:string}>}
 */
export async function solveCaptcha({
  sceneId,
  region = "",
  prefix = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  browser,
  spawn: spawnBrowser = spawn,
  signal,
} = {}) {
  if (!sceneId) throw new Error("ZCode 没有给验证码场景（sceneId）")
  const found = browser ?? findBrowser()
  if (!found?.path) throw new Error("没有可用的 Chromium 浏览器（Chrome / Edge / 国产 Chromium 任一）")

  // 以前失败的残留先扫掉：它们多半是浏览器没杀干净留下的
  sweepProfiles()
  const { port, param, close } = await listen(captchaPage({ sceneId, region, prefix }), { timeoutMs, signal })
  const profile = mkdtempSync(join(tmpdir(), "magpie-zcode-captcha-"))
  const child = spawnBrowser(found.path, [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    // 真窗口、藏到屏幕外：无感验证看指纹，纯 headless 更容易被要求人工
    ...(process.env.MAGPIE_ZCODE_CAPTCHA_HEADLESS === "1"
      ? ["--headless=new"]
      : ["--window-size=420,360", "--window-position=-32000,-32000"]),
    `http://127.0.0.1:${port}/`,
  ], { stdio: "ignore", windowsHide: true })

  try {
    const text = await param
    return { param: text, region }
  } finally {
    killTree(child, profile)
    try { close() } catch {}
    // 浏览器刚被 taskkill，profile 里的文件还锁着：rmSync 的 maxRetries 就是干这个的
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
  }
}

// 全局串行：多账号同时签到只开一个浏览器。前一个失败不能卡住后一个。
let queue = Promise.resolve()

/**
 * solveCaptchaSerially 是插件实际用的入口：把 solveCaptcha 排进全局队列。
 *
 * @param {Parameters<typeof solveCaptcha>[0]} options
 * @returns {Promise<{param:string, region:string}>}
 */
export function solveCaptchaSerially(options) {
  const run = () => solveCaptcha(options)
  const next = queue.then(run, run)
  queue = next.then(() => {}, () => {})
  return next
}

export const _internal = { MAX_PARAM, killTree, queue: () => queue }
