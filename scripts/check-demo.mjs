import assert from "node:assert/strict"

const target = process.argv[2]
if (!target || !/^https?:\/\//.test(target)) throw new Error("Usage: npm run check:demo -- http://127.0.0.1:8787")
const base = new URL(target)
const get = (path, options = {}) => fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(15000) })

const home = await get("/")
assert.equal(home.status, 200)
const html = await home.text()
assert.match(html, /rhine-demo-banner/)
assert.match(html, /id="root"/)
const assets = [...html.matchAll(/(?:src|href)="(\/(?:assets\/[^"]+|demo\.css))"/g)].map((match) => match[1])
assert.ok(assets.length >= 3)
for (const path of assets) {
  const response = await get(path)
  assert.equal(response.status, 200, `Asset failed: ${path}`)
  assert.doesNotMatch(response.headers.get("Content-Type") ?? "", /text\/html/, `SPA HTML at ${path}`)
}
const direct = await get("/node/101")
assert.equal(direct.status, 200)
assert.equal(await direct.text(), html, "Deep links must load the same demo shell")
const admin = await get("/admin/")
assert.equal(admin.status, 200)
assert.doesNotMatch(await admin.text(), /<(?:form|input)\b/i)
assert.match(admin.headers.get("Content-Security-Policy") ?? "", /form-action 'none'/)

const site = await (await get("/api/me")).json()
assert.equal(site.demo, true)
assert.equal(site.authed, false)
assert.equal(site.public_page, true)
const { nodes } = await (await get("/api/nodes")).json()
assert.equal(nodes.length, 6)
assert.ok(nodes.every((node) => node.public && !("ip" in node) && !("token" in node)))
for (const path of ["/api/unknown", "/api/nodes/999/metrics", "/test"]) {
  assert.equal((await get(path, { headers: { "Sec-Fetch-Mode": "navigate" } })).status, 404)
}
assert.equal((await get("/api/nodes", { method: "POST" })).status, 405)
assert.equal((await get("/api/nodes/101/metrics?hours=Infinity")).status, 400)
assert.equal(await (await get("/api/nodes", { method: "HEAD" })).text(), "")

const history = await (await get("/api/nodes/101/metrics?hours=24&points=320&series=ping")).json()
assert.equal(Object.keys(history.probes).length, 7)
assert.ok(history.ping.length > 24000)
assert.ok(history.ping.some((point) => point.latency === null))
assert.ok(history.ping.some((point) => point.latency > 600))
const resources = await (await get("/api/nodes/101/metrics?hours=6&series=metrics")).json()
assert.ok(resources.metrics.length > 0)
assert.equal(resources.ping.length, 0)

const socketUrl = new URL("/api/ws?gzip", base)
socketUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:"
const stream = await new Promise((resolve, reject) => {
  const socket = new WebSocket(socketUrl)
  let frames = 0
  let firstSeen
  const timeout = setTimeout(() => { socket.close(); reject(new Error("Demo WebSocket timed out")) }, 12000)
  const fail = (error) => { clearTimeout(timeout); socket.close(); reject(error) }
  socket.addEventListener("error", () => fail(new Error("Demo WebSocket failed")))
  socket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data)
      assert.equal(data.nodes.length, 6)
      assert.ok(data.nodes.every((node) => node.public))
      firstSeen ??= data.nodes[0].last_seen
      if (++frames >= 2) {
        assert.ok(data.nodes[0].last_seen > firstSeen, "Stream must advance the synthetic clock")
        socket.close(1000)
      }
    } catch (error) { fail(error) }
  })
  socket.addEventListener("close", (event) => {
    clearTimeout(timeout)
    if (frames < 2 || event.code !== 1000) reject(new Error(`Demo stream closed early: ${event.code}`))
    else resolve({ frames, closeCode: event.code })
  })
})
console.log(JSON.stringify({
  target: base.origin, checkedAt: new Date().toISOString(), assets: assets.length,
  nodes: nodes.length, probes: Object.keys(history.probes).length,
  daySamples: history.ping.length, stream,
  result: "passed",
}, null, 2))
