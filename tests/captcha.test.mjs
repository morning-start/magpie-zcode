import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captchaOf, captchaPage, listen, solveCaptcha, sweepProfiles, SDK_URL, TRACELESS_MS } from '../src/captcha.mjs'

// ---- captchaOf：三种结果对应调用方的三条分支 --------------------------------

test('captchaOf：没有 captcha 段 = 这家不查验证码', () => {
  assert.deepEqual(captchaOf({}), { enabled: false, region: '', prefix: '', sceneId: '' })
  assert.deepEqual(captchaOf({ configs: {} }), { enabled: false, region: '', prefix: '', sceneId: '' })
  assert.equal(captchaOf(null).enabled, false)
})

test('captchaOf：对象读成 sceneId / region / prefix / enabled', () => {
  assert.deepEqual(
    captchaOf({ configs: { captcha: { enabled: true, region: 'cn', prefix: 'prefix', sceneId: ' scene ' } } }),
    { enabled: true, region: 'cn', prefix: 'prefix', sceneId: 'scene' }
  )
  // 服务端两种写法都见过
  assert.equal(captchaOf({ configs: { captcha: { scene_id: 'snake' } } }).sceneId, 'snake')
  // enabled 省略 = 开着（ZCode 的默认）
  assert.equal(captchaOf({ configs: { captcha: { sceneId: 's' } } }).enabled, true)
  assert.equal(captchaOf({ configs: { captcha: { enabled: false } } }).enabled, false)
})

test('captchaOf：读不懂的配置是 null（未知），不能当「不用验证」', () => {
  assert.equal(captchaOf({ configs: { captcha: 'on' } }), null)
  assert.equal(captchaOf({ configs: { captcha: [] } }), null)
})

// ---- 页面 ------------------------------------------------------------------

test('captchaPage：注入 scene / region / prefix 与官方 SDK，且脚本不会被引号打断', () => {
  const html = captchaPage({ sceneId: 'scene-1', region: 'cn', prefix: 'pre"fix' })
  assert.ok(html.includes(SDK_URL))
  assert.ok(html.includes(JSON.stringify('scene-1')))
  assert.ok(html.includes(JSON.stringify('cn')))
  assert.ok(html.includes('startTracelessVerification'))
  assert.ok(html.includes(String(TRACELESS_MS)))
  // 引号被 JSON 转义，不会提前结束内联脚本
  assert.ok(html.includes('pre\\"fix'))
})

// ---- 临时服务 --------------------------------------------------------------

test('listen：GET 给页面，POST /param 交回参数', async () => {
  const { port, param, close } = await listen('<html>ok</html>', { timeoutMs: 5000 })
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(await page.text(), '<html>ok</html>')
    await fetch(`http://127.0.0.1:${port}/param`, { method: 'POST', body: 'P-1' })
    assert.equal(await param, 'P-1')
  } finally {
    close()
  }
})

test('listen：POST /fail 带回失败原因（无感要人工 / SDK 出错）', async () => {
  const { port, param, close } = await listen('<html></html>', { timeoutMs: 5000 })
  try {
    const rejected = assert.rejects(param, /interactive/)
    await fetch(`http://127.0.0.1:${port}/fail`, { method: 'POST', body: 'interactive' })
    await rejected
  } finally {
    close()
  }
})

test('listen：超时后拒绝，不悬挂', async () => {
  const { param, close } = await listen('<html></html>', { timeoutMs: 30 })
  try {
    await assert.rejects(param, /timed out/)
  } finally {
    close()
  }
})

// ---- 解法 ------------------------------------------------------------------

test('solveCaptcha：没有 sceneId 直接抛（配置不完整）', async () => {
  await assert.rejects(solveCaptcha({ sceneId: '' }), /sceneId/)
})

test('solveCaptcha：没有可用浏览器时抛错，由调用方降级为 captcha', async () => {
  await assert.rejects(solveCaptcha({ sceneId: 's', browser: {} }), /Chromium/)
})

// ---- 残留清理 --------------------------------------------------------------

// 浏览器没杀干净时 profile 删不掉（实测 5 个残留、Chrome 还挂着）：
// 下次解法开始前把旧的扫掉，别让 %TEMP% 越积越多
test('sweepProfiles 清掉旧的一次性 profile，不碰刚建的', () => {
  const old = mkdtempSync(join(tmpdir(), 'magpie-zcode-captcha-'))
  const fresh = mkdtempSync(join(tmpdir(), 'magpie-zcode-captcha-'))
  try {
    // 三小时后再扫：刚建的那个也过期了，两个都清
    const removed = sweepProfiles({ now: Date.now() + 3 * 3600_000 })
    assert.ok(removed >= 2)
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(fresh), false)
  } finally {
    rmSync(old, { recursive: true, force: true })
    rmSync(fresh, { recursive: true, force: true })
  }
})
