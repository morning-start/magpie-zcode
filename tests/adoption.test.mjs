// tests/adoption.test.mjs —— 外部采用路径：check CLI / create CLI / GitHub Action 形状
//
// 这些测试保护的是「别人能不能用上」，不是插件语义本身：
//   · check.mjs 能吃一个目标目录（不是只能查自己）
//   · create.mjs 生成的新项目身份改对了，并且 check 直接能跑
//   · Action 与 package.json bin 没有在重构里被拆掉
//
// 全部离线；create 只写临时目录，测试结束删掉。

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

function runNode(script, args, cwd = ROOT) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" })
}

test("check.mjs 可以检查传入的目标目录，退出码 0", () => {
  const result = runNode(join(ROOT, "scripts", "check.mjs"), ["--template", ROOT])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /通过 \d+ · 警告 \d+ · 失败 \d+/)
})

test("create.mjs 生成的新插件身份正确，且 check 直接通过", () => {
  const parent = mkdtempSync(join(tmpdir(), "magpie-create-"))
  const target = join(parent, "demo-plugin")
  try {
    const created = runNode(join(ROOT, "scripts", "create.mjs"), [
      "--dir",
      target,
      "--provider",
      "demo",
      "--name",
      "示例 Example",
      "--base",
      "https://api.demo.example/v1",
      "--package",
      "demo-auth",
    ])
    assert.equal(created.status, 0, created.stdout + created.stderr)
    assert.ok(existsSync(join(target, "index.mjs")))
    assert.ok(existsSync(join(target, "src", "refresh-lock.mjs")))
    assert.ok(existsSync(join(target, ".github", "workflows", "ci.yml")))
    assert.ok(existsSync(join(target, "scripts", "publish-npm.mjs")))

    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"))
    assert.equal(pkg.name, "demo-auth")
    assert.equal(pkg.magpie.name, "示例 Example")
    assert.equal(pkg.version, "0.1.0")
    assert.equal(pkg.scripts["publish:npm"], "node scripts/publish-npm.mjs")
    assert.equal(pkg.scripts["check:template"], undefined, "派生插件不能继承模板跳过占位符的检查")
    assert.equal(pkg.repository, undefined, "不能把模板仓库当成派生插件的仓库")
    assert.equal(pkg.bin, undefined, "派生插件不带 CLI bin")

    const publishScript = readFileSync(join(target, "scripts", "publish-npm.mjs"), "utf8")
    assert.match(publishScript, /const PUBLISH_AS = "demo-auth"/)
    const ci = readFileSync(join(target, ".github", "workflows", "ci.yml"), "utf8")
    assert.match(ci, /template: "false"/, "派生项目的 action 自测必须走严格模式")
    assert.doesNotMatch(ci, /template: "true"/)

    const index = readFileSync(join(target, "index.mjs"), "utf8")
    assert.match(index, /const PROVIDER = "demo"/)
    assert.match(index, /const PROVIDER_NAME = "示例 Example"/)
    assert.match(index, /const BASE = "https:\/\/api\.demo\.example\/v1"/)
    assert.match(index, /x-demo-session/, "请求头占位名要跟着 provider 改")

    const context = readFileSync(join(target, "src", "context.mjs"), "utf8")
    assert.match(context, /export const PROVIDER = "demo"/)
    assert.match(context, /export const BASE = "https:\/\/api\.demo\.example\/v1"/)

    const registry = JSON.parse(readFileSync(join(target, "registry-entry.json"), "utf8"))
    assert.equal(registry.package, "demo-auth")
    assert.equal(registry.name, "示例 Example")
    assert.deepEqual(registry.providers, ["demo"])

    const checked = runNode(join(target, "scripts", "check.mjs"), [target])
    assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("create.mjs 强制显示名是 中文 + English，且拒绝占位符", () => {
  const parent = mkdtempSync(join(tmpdir(), "magpie-create-"))
  try {
    const missing = runNode(join(ROOT, "scripts", "create.mjs"), [
      "--dir", join(parent, "missing"), "--provider", "demo",
    ])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /缺少 --name/)

    const englishOnly = runNode(join(ROOT, "scripts", "create.mjs"), [
      "--dir", join(parent, "english"), "--provider", "demo", "--name", "Demo",
    ])
    assert.equal(englishOnly.status, 1)
    assert.match(englishOnly.stderr, /必须是 <中文> <English>/)

    const placeholder = runNode(join(ROOT, "scripts", "create.mjs"), [
      "--dir", join(parent, "placeholder"), "--provider", "demo", "--name", "⚠ 未命名插件 Unnamed Plugin",
    ])
    assert.equal(placeholder.status, 1)
    assert.match(placeholder.stderr, /占位符/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("派生项目里仍留占位符时，check.mjs 退出 1", () => {
  const parent = mkdtempSync(join(tmpdir(), "magpie-create-"))
  const target = join(parent, "placeholder-check")
  try {
    const created = runNode(join(ROOT, "scripts", "create.mjs"), [
      "--dir", target, "--provider", "demo", "--name", "示例 Example", "--package", "demo-auth",
    ])
    assert.equal(created.status, 0, created.stdout + created.stderr)

    const pkgPath = join(target, "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    pkg.name = "unnamed-plugin"
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")

    const checked = runNode(join(target, "scripts", "check.mjs"), [target])
    assert.equal(checked.status, 1, checked.stdout + checked.stderr)
    assert.match(checked.stdout, /name 不是占位符/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("create.mjs 拒绝非空目录，不覆盖已有代码", () => {
  const parent = mkdtempSync(join(tmpdir(), "magpie-create-"))
  const target = join(parent, "occupied")
  try {
    const first = runNode(join(ROOT, "scripts", "create.mjs"), [
      "--dir",
      target,
      "--provider",
      "demo",
      "--name",
      "示例 Demo",
    ])
    assert.equal(first.status, 0, first.stdout + first.stderr)

    const second = runNode(join(ROOT, "scripts", "create.mjs"), [
      "--dir",
      target,
      "--provider",
      "other",
      "--name",
      "示例 Other",
    ])
    assert.equal(second.status, 1)
    assert.match(second.stderr, /目标目录非空/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("cli.mjs 把 check 子命令转发给 check.mjs，未知子命令退出 1", () => {
  const check = runNode(join(ROOT, "scripts", "cli.mjs"), ["check", "--template", ROOT])
  assert.equal(check.status, 0, check.stdout + check.stderr)
  assert.match(check.stdout, /通过 \d+ · 警告 \d+ · 失败 \d+/)

  const unknown = runNode(join(ROOT, "scripts", "cli.mjs"), ["nope"])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /不认识的子命令/)
})

test("package.json 只暴露一个 magpie-plugin bin，CI 自测 Action", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  assert.equal(pkg.bin["magpie-plugin"], "./scripts/cli.mjs")
  assert.equal(Object.keys(pkg.bin).length, 1, "多个 bin 会让 npx 无法判断该跑哪个")

  const action = readFileSync(join(ROOT, ".github", "actions", "check", "action.yml"), "utf8")
  assert.match(action, /using: composite/)
  assert.match(action, /scripts\/check\.mjs/)

  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")
  assert.match(ci, /\.\/\.github\/actions\/check/, "本仓库 CI 必须自测这个 Action")
})
