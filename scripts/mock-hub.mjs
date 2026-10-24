import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { pathToFileURL } from "node:url"
import { TITLES, denseSyntheticHistory, syntheticHistory, syntheticNodes } from "../tests/fixtures.mjs"

const HOST = "127.0.0.1"
const PORT = 9911
const SCENARIOS = new Set([
  "normal", "empty", "closed401", "html200", "wsdrop", "httpfail", "stale",
  "me401", "publicDowngrade", "removeSelected", "dense",
])
const PUBLIC_FIXTURE_IDS = new Set([102, 105])
const MAX_CONTROL_BYTES = 2048
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
const MOCK_ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>MOCK ADMIN / \u672c\u5730\u767b\u5f55\u5360\u4f4d</title>
<style>body{margin:0;background:#e6e2da;color:#20211e;font-family:serif}main{max-width:48rem;margin:12vh auto;padding:2rem}h1{font-size:3rem;letter-spacing:.08em}p{line-height:1.8}small{display:block;margin-top:3rem;color:#55564f}</style>
</head><body><main><h1>MOCK ADMIN</h1><h2>\u672c\u5730\u767b\u5f55\u5360\u4f4d</h2>
<p>\u6b64\u9875\u4ec5\u7528\u4e8e\u9a8c\u8bc1\u4e3b\u9898\u5728\u6743\u9650\u5931\u6548\u65f6\u8df3\u8f6c\u5230\u7ba1\u7406\u5165\u53e3\u3002</p>
<p>\u4e0d\u662f\u771f\u5b9e Monitor \u540e\u53f0\uff0c\u4e0d\u63d0\u4f9b\u767b\u5f55\u8868\u5355\uff0c\u4e0d\u63a5\u6536\u6216\u63d0\u4ea4\u4efb\u4f55\u51ed\u8bc1\u3002</p>
<small>synthetic-local-only / 127.0.0.1</small></main></body></html>`

function localUrl(value) {
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && LOOPBACK.has(url.hostname)
  } catch {
    return false
  }
}

function localRequest(req) {
  const address = req.socket.remoteAddress
  return (address === HOST || address === "::ffff:127.0.0.1")
    && localUrl(`http://${req.headers.host}`)
    && (!req.headers.origin || localUrl(req.headers.origin))
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = type.startsWith("application/json") ? JSON.stringify(body) : String(body)
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Rhine-Fixture": "synthetic-local-only",
  })
  res.end(data)
}

function textFrame(text, opcode = 1) {
  const data = Buffer.isBuffer(text) ? text : Buffer.from(text)
  if (data.length > 65535) throw new Error("Mock frame exceeds its small-frame budget")
  const header = Buffer.alloc(data.length < 126 ? 2 : 4)
  header[0] = 0x80 | opcode
  header[1] = data.length < 126 ? data.length : 126
  if (header.length === 4) header.writeUInt16BE(data.length, 2)
  return Buffer.concat([header, data])
}

export function createMockHub({ ephemeral = false } = {}) {
  // Only tests opt into an OS-assigned port. The CLI remains fixed to 127.0.0.1:9911.
  const listenPort = ephemeral === true ? 0 : PORT
  let boundPort = listenPort
  let scenario = "normal"
  let title = "normal"
  const clients = new Set()
  const counters = { requests: 0, nodes: 0, histories: 0, websocketAccepted: 0, websocketRejected: 0, frames: 0 }
  const stats = () => ({
    fixture: "synthetic-local-only",
    host: HOST,
    port: boundPort,
    scenario,
    title,
    site_name: TITLES[title],
    clients: clients.size,
    counters: { ...counters },
    scenarios: [...SCENARIOS],
    titles: Object.keys(TITLES),
  })
  const snapshot = () => {
    let nodes = scenario === "empty" ? [] : syntheticNodes()
    if (scenario === "removeSelected") nodes = nodes.filter((node) => node.id !== 101)
    if (scenario === "publicDowngrade") {
      nodes = nodes.filter((node) => PUBLIC_FIXTURE_IDS.has(node.id)).map((node) => ({ ...node, public: true }))
    }
    return { nodes }
  }
  const mayStream = () => ["normal", "empty", "me401", "publicDowngrade", "removeSelected", "dense"].includes(scenario)
  const broadcast = () => {
    if (!mayStream()) return
    const payload = textFrame(JSON.stringify(snapshot()))
    for (const socket of clients) {
      if (!socket.destroyed && socket.writableLength < 1024 * 1024) {
        socket.write(payload)
        counters.frames++
      }
    }
  }
  const closeClients = () => {
    for (const socket of clients) socket.destroy()
    clients.clear()
  }

  const server = createServer(async (req, res) => {
    if (!localRequest(req)) return send(res, 403, "Local fixture access only", "text/plain")
    const url = new URL(req.url, `http://${HOST}:${PORT}`)
    if (url.pathname === "/test") {
      if (req.method === "GET") return send(res, 200, stats())
      if (req.method !== "POST") return send(res, 405, "Use GET or POST", "text/plain")
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        return send(res, 415, "Use application/json", "text/plain")
      }
      try {
        let body = ""
        for await (const chunk of req) {
          body += chunk
          if (Buffer.byteLength(body) > MAX_CONTROL_BYTES) {
            send(res, 413, "Control payload too large", "text/plain")
            return
          }
        }
        const change = JSON.parse(body)
        if (!change || typeof change !== "object" || Array.isArray(change)
          || Object.keys(change).some((key) => !["scenario", "title", "resetCounters"].includes(key))
          || (change.scenario !== undefined && !SCENARIOS.has(change.scenario))
          || (change.title !== undefined && !Object.hasOwn(TITLES, change.title))
          || (change.resetCounters !== undefined && typeof change.resetCounters !== "boolean")) {
          return send(res, 400, "Invalid control state", "text/plain")
        }
        const previousScenario = scenario
        if (change.scenario !== undefined) scenario = change.scenario
        if (change.title !== undefined) title = change.title
        if (change.resetCounters) for (const key of Object.keys(counters)) counters[key] = 0
        // Stale keeps the TCP socket open but silent, exercising the browser watchdog.
        if (!mayStream() && scenario !== "stale") closeClients()
        // A full-access stream must never carry on across an audience change.
        if (scenario !== previousScenario && [scenario, previousScenario].includes("publicDowngrade")) closeClients()
        broadcast()
        return send(res, 200, stats())
      } catch {
        if (!res.headersSent) send(res, 400, "Invalid JSON", "text/plain")
        return
      }
    }
    if (req.method !== "GET") return send(res, 405, "Fixture is read-only", "text/plain")
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'")
      return send(res, 200, MOCK_ADMIN_HTML, "text/html; charset=utf-8")
    }
    if (!url.pathname.startsWith("/api/")) {
      return send(res, 200, {
        fixture: "synthetic-local-only",
        help: "Proxy /api to this server from the local Vite preview. POST /test to change failure scenarios.",
      })
    }
    counters.requests++
    if (scenario === "html200") {
      return send(res, 200, "<!doctype html><title>Fixture challenge</title><p>Not JSON: simulated proxy challenge.</p>", "text/html; charset=utf-8")
    }
    if (scenario === "httpfail" || scenario === "stale") {
      return send(res, 503, "Synthetic local outage", "text/plain; charset=utf-8")
    }
    if (url.pathname === "/api/me") {
      // Intentionally isolate metadata authorization failure while snapshots still
      // arrive, so the client must clear and gate them rather than trust old access.
      if (scenario === "me401") return send(res, 401, "Synthetic session expired", "text/plain; charset=utf-8")
      return send(res, 200, {
        authed: !["closed401", "publicDowngrade"].includes(scenario),
        github: false,
        site_name: TITLES[title],
        public_page: scenario === "publicDowngrade",
        history_days: 7,
        site: "",
      })
    }
    if (scenario === "closed401") return send(res, 401, "\u9700\u8981\u767b\u5f55\u540e\u67e5\u770b", "text/plain; charset=utf-8")
    if (url.pathname === "/api/nodes") {
      counters.nodes++
      return send(res, 200, snapshot())
    }
    const history = /^\/api\/nodes\/(10[1-6])\/metrics$/.exec(url.pathname)
    if (history) {
      const id = Number(history[1])
      if (scenario === "publicDowngrade" && !PUBLIC_FIXTURE_IDS.has(id)) {
        return send(res, 401, "Synthetic private node requires login", "text/plain; charset=utf-8")
      }
      if (scenario === "removeSelected" && id === 101) {
        return send(res, 404, "Synthetic node was removed", "text/plain; charset=utf-8")
      }
      counters.histories++
      const historyFixture = scenario === "dense" ? denseSyntheticHistory : syntheticHistory
      return send(res, 200, historyFixture(id, url.searchParams))
    }
    if (/^\/api\/theme\/[^/]+\/config$/.test(url.pathname)
      || /^\/api\/themes\/[^/]+\/config$/.test(url.pathname)) return send(res, 200, {})
    return send(res, 404, "Unknown synthetic endpoint", "text/plain; charset=utf-8")
  })

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`)
    const key = req.headers["sec-websocket-key"]
    if (!localRequest(req) || url.pathname !== "/api/ws" || !mayStream()
      || req.headers.upgrade?.toLowerCase() !== "websocket"
      || req.headers["sec-websocket-version"] !== "13"
      || typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
      counters.websocketRejected++
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      return
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    clients.add(socket)
    counters.websocketAccepted++
    socket.on("error", () => clients.delete(socket))
    socket.on("close", () => clients.delete(socket))
    // No application messages are needed, only the browser's masked control frames.
    let pending = Buffer.alloc(0)
    socket.on("data", (data) => {
      pending = Buffer.concat([pending, data])
      if (pending.length > 4096) return socket.destroy()
      while (pending.length >= 2) {
        const opcode = pending[0] & 15
        const length = pending[1] & 127
        if (!(pending[0] & 0x80) || !(pending[1] & 0x80) || length >= 126 || ![8, 9, 10].includes(opcode)) {
          socket.destroy()
          return
        }
        if (pending.length < 6 + length) return
        const mask = pending.subarray(2, 6)
        const payload = Buffer.from(pending.subarray(6, 6 + length))
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
        pending = pending.subarray(6 + length)
        if (opcode === 8) {
          socket.end(textFrame(payload, 8))
          return
        }
        if (opcode === 9) socket.write(textFrame(payload, 10))
      }
    })
    socket.write(textFrame(JSON.stringify(snapshot())))
    counters.frames++
  })
  const timer = setInterval(broadcast, 2000)
  timer.unref()
  server.on("close", () => {
    clearInterval(timer)
    closeClients()
  })
  return {
    server,
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(listenPort, HOST, resolve)
      })
      boundPort = server.address().port
      return stats()
    },
    async close() {
      clearInterval(timer)
      closeClients()
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hub = createMockHub()
  hub.listen().then((state) => console.log(JSON.stringify(state))).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => hub.close().then(() => process.exit(0)))
}
