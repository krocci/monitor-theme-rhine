import { denseSyntheticHistory, syntheticNodes } from "../tests/fixtures.mjs"

const DEMO_TITLE = "Rhine Observation \u00b7 \u6f14\u793a\u7ad9"
const FIXTURE = "synthetic-public-demo"
const NODE_IDS = new Set([101, 102, 103, 104, 105, 106])

function reply(request, body, status = 200, type = "application/json; charset=utf-8", extra = {}) {
  return new Response(request.method === "HEAD" ? null : type.startsWith("application/json") ? JSON.stringify(body) : body, {
    status,
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Rhine-Fixture": FIXTURE,
      ...extra,
    },
  })
}

const text = (request, body, status, extra) => reply(request, body, status, "text/plain; charset=utf-8", extra)
const snapshot = () => ({
  nodes: syntheticNodes().map((node) => ({
    ...node, public: true, public_remark: "Synthetic public demo; not a live server.",
  })),
})

function stream(request) {
  const origin = request.headers.get("Origin")
  if (origin && origin !== new URL(request.url).origin) return text(request, "Cross-origin stream is not available.", 403)
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return text(request, "Use a WebSocket upgrade.", 426, { Upgrade: "websocket" })
  }
  const [client, server] = Object.values(new WebSocketPair())
  server.accept()
  let interval
  let expiry
  const cleanup = () => {
    clearInterval(interval)
    clearTimeout(expiry)
  }
  const close = (code, reason) => {
    cleanup()
    if (server.readyState === 1) server.close(code, reason)
  }
  const send = () => {
    if (server.readyState !== 1) return cleanup()
    try { server.send(JSON.stringify(snapshot())) } catch { close(1011, "Demo stream ended") }
  }
  server.addEventListener("close", cleanup)
  server.addEventListener("error", () => close(1011, "Demo stream error"))
  // A demo has no application messages or write operations.
  server.addEventListener("message", () => close(1008, "Demo stream is read-only"))
  interval = setInterval(send, 2000)
  // Bound each stream's lifetime; the theme reconnects using its normal transport.
  expiry = setTimeout(() => close(1000, "Demo stream refresh"), 10 * 60 * 1000)
  send()
  return new Response(null, { status: 101, webSocket: client })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!["GET", "HEAD"].includes(request.method)) {
      return text(request, "The demo is read-only.", 405, { Allow: "GET, HEAD" })
    }
    if (url.pathname === "/api/me") {
      return reply(request, {
        authed: false, github: false, public_page: true, site_name: DEMO_TITLE,
        history_days: 7, site: "", demo: true,
      })
    }
    if (url.pathname === "/api/nodes") return reply(request, snapshot())
    if (url.pathname === "/api/ws") return stream(request)
    const history = /^\/api\/nodes\/(\d+)\/metrics$/.exec(url.pathname)
    if (history) {
      const id = Number(history[1])
      if (!NODE_IDS.has(id)) return text(request, "Unknown demo node.", 404)
      // Keep request work bounded, including malformed or infinite hour values.
      const params = new URLSearchParams(url.searchParams)
      const hours = Number(params.get("hours") ?? 6)
      if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
        return text(request, "hours must be between 1 and 168.", 400)
      }
      if (params.has("series") && !["ping", "metrics"].includes(params.get("series"))) {
        return text(request, "Unknown demo series.", 400)
      }
      return reply(request, denseSyntheticHistory(id, params))
    }
    if (/^\/api\/themes?\/rhine\/config$/.test(url.pathname)) return reply(request, {})
    // Never let an unknown API or the private local mock controller fall through to SPA HTML.
    if (/^\/(?:api|test)(?:\/|$)/.test(url.pathname)) return text(request, "Unknown demo endpoint.", 404)
    if (/^\/admin(?:\/|$)/.test(url.pathname)) {
      const response = await env.ASSETS.fetch(new Request(new URL("/demo-admin", url), request))
      const headers = new Headers(response.headers)
      headers.set("Cache-Control", "no-store")
      headers.set("Content-Security-Policy", "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      return new Response(response.body, { status: response.status, headers })
    }
    return env.ASSETS.fetch(request)
  },
}
