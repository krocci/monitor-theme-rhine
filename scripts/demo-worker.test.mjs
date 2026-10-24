import assert from "node:assert/strict"
import { test } from "node:test"
import worker from "./demo-worker.mjs"

const origin = "https://rhine-demo.example"
const request = (path, options) => worker.fetch(new Request(new URL(path, origin), options), {
  ASSETS: { fetch: async (asset) => new Response(`asset:${new URL(asset.url).pathname}`, { headers: { "Content-Type": "text/html" } }) },
})

test("public demo exposes synthetic public metadata and nodes", async () => {
  const response = await request("/api/me")
  assert.equal(response.headers.get("X-Rhine-Fixture"), "synthetic-public-demo")
  assert.equal(response.headers.get("Cache-Control"), "no-store")
  const site = await response.json()
  assert.equal(site.site_name, "Rhine Observation \u00b7 \u6f14\u793a\u7ad9")
  assert.equal(site.authed, false)
  assert.equal(site.public_page, true)
  const { nodes } = await (await request("/api/nodes")).json()
  assert.equal(nodes.length, 6)
  assert.ok(nodes.every((node) => node.public && !("ip" in node) && !("token" in node)))
  assert.equal(nodes[2].online, false)
  assert.equal(nodes[3].metrics, null)
})

test("dense demo history preserves seven probes, raw day volume, spikes and loss", async () => {
  const history = await (await request("/api/nodes/101/metrics?hours=24&series=ping&points=320")).json()
  assert.equal(Object.keys(history.probes).length, 7)
  assert.ok(history.ping.length > 24000)
  assert.equal(history.metrics.length, 0)
  assert.ok(history.ping.some((point) => point.latency === null))
  assert.ok(history.ping.some((point) => point.latency > 600))
  for (const id of Object.keys(history.probes).map(Number)) {
    const points = history.ping.filter((point) => point.task_id === id)
    assert.ok(points.some((point, index) => index > 0 && point.ts - points[index - 1].ts > 24))
    assert.equal(history.loss[id], points.filter((point) => point.latency === null).length / points.length * 100)
  }
  const resource = await (await request("/api/nodes/101/metrics?series=metrics")).json()
  assert.ok(resource.metrics.length > 0)
  assert.equal(resource.ping.length, 0)
})

test("demo rejects writes, unknown nodes, malformed ranges and the local controller", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/api/nodes", "/api/ws", "/test", "/admin/"]) {
      const response = await request(path, { method })
      assert.equal(response.status, 405)
      assert.equal(response.headers.get("Allow"), "GET, HEAD")
    }
  }
  for (const path of ["/api", "/api/unknown", "/api/nodes/999/metrics", "/test", "/test/anything"]) {
    assert.equal((await request(path)).status, 404)
  }
  for (const hours of ["Infinity", "NaN", "0", "-1", "169", "1e99"]) {
    assert.equal((await request(`/api/nodes/101/metrics?hours=${hours}`)).status, 400)
  }
  assert.equal((await request("/api/nodes/101/metrics?series=invalid")).status, 400)
  assert.equal((await request("/api/themes/rhine/config")).status, 200)
  assert.equal((await request("/api/theme/rhine/config")).status, 200)
})

test("HEAD has no body; API errors stay text even for browser navigations", async () => {
  const response = await request("/api/nodes", { method: "HEAD" })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), "")
  const missing = await request("/api/missing", { headers: { "Sec-Fetch-Mode": "navigate" } })
  assert.equal(missing.status, 404)
  assert.match(missing.headers.get("Content-Type"), /^text\/plain/)
  assert.equal((await request("/api/ws")).status, 426)
  assert.equal((await request("/api/ws", { headers: { Origin: "https://other.example", Upgrade: "websocket" } })).status, 403)
})

test("admin is an inert demo explanation; other paths use the assets binding", async () => {
  const admin = await request("/admin/")
  assert.equal(await admin.text(), "asset:/demo-admin")
  assert.match(admin.headers.get("Content-Security-Policy"), /form-action 'none'/)
  assert.equal(await (await request("/node/101")).text(), "asset:/node/101")
})
