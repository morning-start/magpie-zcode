// tests/support/bun.mjs —— 上游测试用到的两个 Bun 全局：serve / sleep
//
// 上游的端到端测试起一个本地服务器当假上游（Bun.serve），把插件的出站请求
// 重定向到它上面。本仓库跑在 node 上，这里用 node:http 实现同样的形状：
// 返回 { port, stop() }，fetch 回调收到 Web 标准的 Request、返回 Response。
//
// 只在测试里用；插件本身不依赖这个文件。

import { createServer } from "node:http"

// pipe writes a Response out as it comes, as Bun.serve streams one. A
// handler that answers with a stream (a fake upstream's SSE, a body that
// never ends) must reach the plugin before the body's end: buffering the
// whole body first means the response headers never go out and the plugin's
// fetch never resolves at all.
async function pipe(response, res) {
  const headers = Object.fromEntries(response.headers)
  // a streamed body's length isn't known before it ends: Node writes it
  // chunked rather than with a length that would cut the body short
  if (response.body) delete headers["content-length"]
  res.writeHead(response.status, headers)
  res.flushHeaders?.()
  if (!response.body) return res.end()
  const reader = response.body.getReader()
  let gone = false
  // the client gave up (a cancelled answer): stop reading the handler's
  // stream, or a body that never ends keeps the process alive
  res.on("close", () => {
    gone = true
    reader.cancel().catch(() => {})
  })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (gone) return
      res.write(Buffer.from(value))
    }
    res.end()
  } catch {
    res.destroy()
  }
}

function serve({ port = 0, fetch: handler }) {
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      const request = new Request(`http://127.0.0.1:${server.address()?.port ?? port}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      })
      await pipe(await handler(request), res)
    } catch (e) {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(e?.stack ?? e))
    }
  })
  server.listen(port)
  return {
    get port() {
      return server.address()?.port ?? port
    },
    stop() {
      server.close()
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

globalThis.Bun = { ...(globalThis.Bun ?? {}), serve, sleep }

export { serve, sleep }
