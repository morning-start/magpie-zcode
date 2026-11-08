// tests/support/bun-test.mjs —— 上游测试套件的 node:test 适配层
//
// 上游（magpie-community/plugins 的 packages/zcode）用 `bun:test` 写测试。
// 本仓库的交付门是 `node --test`，所以这里实现用到的那些 API：
// test / expect（含 .not / .rejects）/ 四个生命周期钩子 / spyOn。
//
// ⚠ 语义要对齐 bun，不是对齐 assert：`toEqual` 忽略值为 undefined 的键、
// `toThrow("…")` 是「消息里包含」，`rejects.toThrow()` 等 promise。
// 改这个文件等于改所有测试的语义，别为了修一条测试去动它。

import { test, after as afterAll, afterEach, before as beforeAll, beforeEach } from "node:test"
import assert from "node:assert"

export { test, afterAll, afterEach, beforeAll, beforeEach }

const label = (v) => {
  try {
    const s = typeof v === "string" ? JSON.stringify(v) : String(v)
    return s.length > 200 ? s.slice(0, 200) + "…" : s
  } catch {
    return String(v)
  }
}

// Asymmetric 是 bun 的 expect.any(...) / expect.stringContaining(...) 这类
// 非对称匹配器：它不和一个值相等，而是「检查那个值」。
class Asymmetric {
  constructor(test, what) {
    this.test = test
    this.what = what
  }
}

// eq 是 bun 的 toEqual 语义：值相等即算，且忽略值为 undefined 的键
function eq(a, b) {
  if (b instanceof Asymmetric) return b.test(a)
  if (Object.is(a, b)) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false
    for (const [k, v] of a) if (!b.has(k) || !eq(v, b.get(k))) return false
    return true
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false
    for (const v of a) if (![...b].some((x) => eq(v, x))) return false
    return true
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => eq(v, b[i]))
  const ka = Object.keys(a).filter((k) => a[k] !== undefined)
  const kb = Object.keys(b).filter((k) => b[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((k) => eq(a[k], b[k]))
}

// subset 是 toMatchObject 语义：b 的每个键都在 a 里且相等
function subset(a, b) {
  if (b instanceof Asymmetric) return b.test(a)
  if (typeof b !== "object" || b === null) return eq(a, b)
  if (typeof a !== "object" || a === null) return false
  return Object.keys(b).every((k) => (b[k] === undefined ? true : subset(a[k], b[k])))
}

function messageText(e) {
  return String(e?.message ?? e ?? "")
}

class Assertion {
  constructor(actual, negate = false) {
    this.actual = actual
    this.negate = negate
  }

  get not() {
    return new Assertion(this.actual, !this.negate)
  }

  ok(pass, say) {
    if (this.negate ? pass : !pass) assert.fail(`${this.negate ? "not " : ""}${say}`)
  }

  toBe(expected) {
    this.ok(Object.is(this.actual, expected), `expected ${label(this.actual)} to be ${label(expected)}`)
  }

  toEqual(expected) {
    this.ok(eq(this.actual, expected), `expected ${label(this.actual)} to equal ${label(expected)}`)
  }

  toStrictEqual(expected) {
    this.ok(eq(this.actual, expected), `expected ${label(this.actual)} to strictly equal ${label(expected)}`)
  }

  toMatchObject(expected) {
    this.ok(subset(this.actual, expected), `expected ${label(this.actual)} to match ${label(expected)}`)
  }

  toContain(item) {
    const has = typeof this.actual === "string" ? this.actual.includes(item) : Array.isArray(this.actual) ? this.actual.some((x) => Object.is(x, item) || eq(x, item)) : false
    this.ok(has, `expected ${label(this.actual)} to contain ${label(item)}`)
  }

  toMatch(pattern) {
    const s = String(this.actual ?? "")
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern))
    this.ok(re.test(s), `expected ${label(s)} to match ${String(pattern)}`)
  }

  toStartWith(prefix) {
    const s = String(this.actual ?? "")
    this.ok(s.startsWith(String(prefix)), `expected ${label(s)} to start with ${label(prefix)}`)
  }

  toEndWith(suffix) {
    const s = String(this.actual ?? "")
    this.ok(s.endsWith(String(suffix)), `expected ${label(s)} to end with ${label(suffix)}`)
  }

  toHaveLength(n) {
    this.ok(this.actual != null && this.actual.length === n, `expected length ${this.actual?.length} to be ${n}`)
  }

  toBeUndefined() {
    this.ok(this.actual === undefined, `expected ${label(this.actual)} to be undefined`)
  }

  toBeDefined() {
    this.ok(this.actual !== undefined, `expected value to be defined`)
  }

  toBeNull() {
    this.ok(this.actual === null, `expected ${label(this.actual)} to be null`)
  }

  toBeTruthy() {
    this.ok(!!this.actual, `expected ${label(this.actual)} to be truthy`)
  }

  toBeFalsy() {
    this.ok(!this.actual, `expected ${label(this.actual)} to be falsy`)
  }

  toBeGreaterThan(n) {
    this.ok(this.actual > n, `expected ${label(this.actual)} > ${n}`)
  }

  toBeGreaterThanOrEqual(n) {
    this.ok(this.actual >= n, `expected ${label(this.actual)} >= ${n}`)
  }

  toBeLessThan(n) {
    this.ok(this.actual < n, `expected ${label(this.actual)} < ${n}`)
  }

  toBeLessThanOrEqual(n) {
    this.ok(this.actual <= n, `expected ${label(this.actual)} <= ${n}`)
  }

  toBeCloseTo(n, digits = 2) {
    const d = Math.abs(Number(this.actual) - Number(n))
    this.ok(d < Math.pow(10, -digits) / 2, `expected ${label(this.actual)} to be close to ${n}`)
  }

  toBeInstanceOf(ctor) {
    this.ok(this.actual instanceof ctor, `expected ${label(this.actual)} to be a ${ctor?.name}`)
  }

  // toThrow 是同步版本：actual 必须是函数
  toThrow(want) {
    let threw = false
    let error = null
    try {
      this.actual()
    } catch (e) {
      threw = true
      error = e
    }
    this.ok(threw, "expected the function to throw")
    if (!threw || want === undefined) return
    const text = typeof want === "string" ? messageText(error) : messageText(error)
    const pass = want instanceof RegExp ? want.test(text) : text.includes(String(want))
    this.ok(pass, `expected thrown message ${label(text)} to match ${label(want)}`)
  }

  get rejects() {
    const actual = this.actual
    return {
      toThrow: async (want) => {
        let error = null
        let threw = false
        try {
          await actual
        } catch (e) {
          threw = true
          error = e
        }
        if (this.negate ? threw : !threw) assert.fail(this.negate ? `expected the promise to resolve, it rejected: ${label(messageText(error))}` : "expected the promise to reject, it resolved")
        if (!threw || want === undefined) return
        const text = messageText(error)
        const pass = want instanceof RegExp ? want.test(text) : text.includes(String(want))
        if (this.negate ? pass : !pass) assert.fail(`expected rejection ${label(text)} to ${this.negate ? "not " : ""}match ${label(want)}`)
      },
    }
  }
}

export function expect(actual) {
  return new Assertion(actual)
}

// expect.any(String) / expect.any(Number) ……：只要求「是那个构造器的实例」
expect.any = (ctor) =>
  new Asymmetric(
    (v) => (ctor === String || ctor === Number || ctor === Boolean ? typeof v === ctor.name.toLowerCase() : v instanceof ctor),
    `any(${ctor?.name})`,
  )

// expect.stringContaining / expect.arrayContaining：上游暂时没用到，先留最小实现
expect.stringContaining = (text) => new Asymmetric((v) => typeof v === "string" && v.includes(text), `stringContaining(${text})`)
expect.arrayContaining = (items) =>
  new Asymmetric((v) => Array.isArray(v) && items.every((item) => v.some((x) => eq(x, item))), `arrayContaining(${items.length})`)

// spyOn 是 bun 的形状：返回的 spy 既是函数又有 .mock.calls / .mockReturnValue /
// .mockImplementation / .mockRestore
export function spyOn(obj, key) {
  const original = obj[key]
  const calls = []
  let impl = null
  const spy = (...args) => {
    calls.push(args)
    if (impl) return impl(...args)
    return typeof original === "function" ? original.apply(obj, args) : original
  }
  spy.mock = {
    calls,
    mockReturnValue(value) {
      impl = () => value
      return spy
    },
    mockImplementation(fn) {
      impl = fn
      return spy
    },
    mockRestore() {
      obj[key] = original
    },
  }
  Object.assign(spy, {
    mockReturnValue: spy.mock.mockReturnValue,
    mockImplementation: spy.mock.mockImplementation,
    mockRestore: spy.mock.mockRestore,
  })
  obj[key] = spy
  return spy
}

