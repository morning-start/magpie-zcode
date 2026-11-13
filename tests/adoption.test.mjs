import "./support/home.mjs"
import "./support/bun.mjs"
// tests/adoption.test.mjs —— 外部采用路径（派生仓库版）
//
// 这个仓库是从 magpie 插件模板派生出来的 **ZCode 插件**，所以这里守的不是
// 「模板生成器还能不能生成新项目」（那个契约属于模板仓库自己），而是：
//   · 交付门 `node scripts/check.mjs` 在本仓库退出 0
//   · 身份没改对（还叫 unnamed-plugin）时交付门必须退出 1 —— 派生仓库最常见的错
//   · `scripts/cli.mjs` 的 check 子命令仍然转发给 check.mjs
//   · 包、Action、CI 的形状在重构里没被拆掉
//
// 全部离线；临时目录用完删掉。

import test from "node:test"
import assert from "node:assert/strict"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

function runNode(script, args, cwd = ROOT) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" })
}

// 复制一份仓库（不带 .git / node_modules / 调试残留）到临时目录
function copyRepo(target) {
  const skip = new Set([".git", "node_modules", "kifu"])
  cpSync(ROOT, target, {
    recursive: true,
    filter: (from) => {
      const name = from.split(/[\\/]/).pop()
      return !skip.has(name) && !name.endsWith(".log")
    },
  })
}

test("check.mjs 在本仓库退出 0（交付门）", () => {
  const result = runNode(join(ROOT, "scripts", "check.mjs"), [])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /通过 \d+ · 警告 \d+ · 失败 \d+/)
})

test("派生仓库身份没改对时，check.mjs 退出 1", () => {
  const parent = mkdtempSync(join(tmpdir(), "magpie-adopt-"))
  const target = join(parent, "placeholder-check")
  try {
    copyRepo(target)
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

test("cli.mjs 把 check 子命令转发给 check.mjs，未知子命令退出 1", () => {
  const check = runNode(join(ROOT, "scripts", "cli.mjs"), ["check"])
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
