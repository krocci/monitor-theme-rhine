import assert from "node:assert/strict"
import { test } from "node:test"
import { createMockHub } from "./mock-hub.mjs"
import { denseSyntheticHistory, NORMAL_TITLE, TITLES } from "../tests/fixtures.mjs"

let BASE
const control = async (data) => {
  const response = await fetch(`${BASE}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  assert.equal(response.status, 200)
  return response.json()
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nextFrame = (socket) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("No synthetic WebSocket frame")), 3000)
  socket.addEventListener("message", (event) => {
    clearTimeout(timeout)
    resolve(event.data)
  }, { once: true })
  socket.addEventListener("error", () => {
    clearTimeout(timeout)
    reject(new Error("Synthetic WebSocket failed"))
  }, { once: true })
})
const openStream = async () => {
  const socket = new WebSocket(`${BASE.replace("http:", "ws:")}/api/ws?gzip`)
  return { socket, first: await nextFrame(socket) }
}

test("synthetic local hub contracts and failure controls", async (suite) => {
  const hub = createMockHub({ ephemeral: true })
  const state = await hub.listen()
  BASE = `http://127.0.0.1:${state.port}`
  suite.after(() => hub.close())
  await suite.test("binds loopback and serves native hub metadata", async () => {
    assert.equal(hub.server.address().address, "127.0.0.1")
    const me = await (await fetch(`${BASE}/api/me`)).json()
    assert.equal(me.site_name, NORMAL_TITLE)
    assert.equal(me.authed, true)
    assert.equal(me.public_page, false)
    assert.equal(me.history_days, 7)
  })
  await suite.test("six fixtures cover offline, no metrics, absent group and long names", async () => {
    const { nodes } = await (await fetch(`${BASE}/api/nodes`)).json()
    assert.deepEqual(nodes.map((node) => node.id), [101, 102, 103, 104, 105, 106])
    assert.equal(nodes[2].online, false)
    assert.equal(nodes[2].metrics, null)
    assert.equal(nodes[3].online, true)
    assert.equal(nodes[3].metrics, null)
    assert.equal(nodes[3].last_seen_ago, null)
    assert.equal(Object.hasOwn(nodes[4], "group"), false)
    assert.ok(nodes[5].name.length > 50)
    assert.ok(nodes.every((node) => !Object.hasOwn(node, "ip") && !Object.hasOwn(node, "token")))
  })
  await suite.test("history distinguishes mixed timeout, all failed, and unsampled probes", async () => {
    const history = await (await fetch(`${BASE}/api/nodes/101/metrics?hours=6&series=ping`)).json()
    assert.equal(history.metrics.length, 0)
    assert.equal(Object.keys(history.probes).length, 4)
    assert.ok(history.ping.some((point) => point.task_id === 202 && point.latency === null))
    assert.ok(history.ping.filter((point) => point.task_id === 203).every((point) => point.latency === null))
    assert.ok(!history.ping.some((point) => point.task_id === 204))
    assert.equal(history.loss[203], 100)
    const empty = await (await fetch(`${BASE}/api/nodes/104/metrics`)).json()
    assert.equal(empty.metrics.length, 0)
    assert.equal(empty.ping.length, 0)
    assert.ok(Object.keys(empty.probes).length > 0)
  })
  await suite.test("native WebSocket receives text even with the gzip opt-in", async () => {
    const { socket, first: frame } = await openStream()
    assert.equal(typeof frame, "string")
    assert.equal(JSON.parse(frame).nodes.length, 6)
    socket.close()
    await wait(20)
  })
  await suite.test("dense day history preserves raw volume, loss, clock offsets, spikes and gaps", async () => {
    const params = new URLSearchParams("hours=24&points=320&series=ping")
    const history = denseSyntheticHistory(101, params, 1792800000)
    assert.deepEqual(history, denseSyntheticHistory(101, params, 1792800000), "Fixed clock makes the fixture reproducible")
    assert.equal(Object.keys(history.probes).length, 7)
    assert.equal(history.metrics.length, 0)
    assert.ok(history.ping.length > 24000)
    assert.ok(history.ping.every((point, index) => index === 0 || point.ts >= history.ping[index - 1].ts))
    const firstTimes = []
    for (const id of Object.keys(history.probes).map(Number)) {
      const points = history.ping.filter((point) => point.task_id === id)
      firstTimes.push(points[0].ts)
      assert.ok(points.length > 2880, "A one-day raw series must exceed the small display point budget")
      const failed = points.filter((point) => point.latency === null).length
      assert.equal(history.loss[id], failed / points.length * 100)
      assert.ok(history.loss[id] >= 9 && history.loss[id] <= 17)
      assert.ok(points.some((point) => point.latency !== null && point.latency > 600))
      assert.ok(points.some((point, index) => index > 0 && point.ts - points[index - 1].ts > 24))
    }
    assert.equal(new Set(firstTimes).size, 7, "Probes must not share an artificial common clock")
    await control({ scenario: "dense" })
    const response = await fetch(`${BASE}/api/nodes/101/metrics?${params}`)
    assert.equal(response.status, 200)
    const served = await response.json()
    assert.equal(served.ping.length, history.ping.length)
    assert.equal(Object.keys(served.probes).length, 7)
    const { socket, first } = await openStream()
    assert.equal(JSON.parse(first).nodes.length, 6)
    socket.close()
    await control({ scenario: "normal" })
    const normal = await (await fetch(`${BASE}/api/nodes/101/metrics?${params}`)).json()
    assert.ok(normal.ping.length < 1000, "Switching back restores the ordinary small fixture")
  })
  await suite.test("titles remain JSON strings, including HTML-looking text", async () => {
    for (const title of ["empty", "long", "malicious"]) {
      await control({ title })
      const me = await (await fetch(`${BASE}/api/me`)).json()
      assert.equal(me.site_name, TITLES[title])
    }
    await control({ title: "normal" })
  })
  await suite.test("failure scenarios are distinguishable", async () => {
    await control({ scenario: "empty" })
    assert.deepEqual(await (await fetch(`${BASE}/api/nodes`)).json(), { nodes: [] })
    await control({ scenario: "closed401" })
    assert.equal((await fetch(`${BASE}/api/nodes`)).status, 401)
    assert.equal((await (await fetch(`${BASE}/api/me`)).json()).authed, false)
    await control({ scenario: "html200" })
    const html = await fetch(`${BASE}/api/nodes`)
    assert.equal(html.status, 200)
    assert.match(html.headers.get("content-type"), /^text\/html/)
    for (const scenario of ["httpfail", "stale"]) {
      await control({ scenario })
      assert.equal((await fetch(`${BASE}/api/nodes`)).status, 503)
    }
    await control({ scenario: "wsdrop" })
    assert.equal((await fetch(`${BASE}/api/nodes`)).status, 200)
    await control({ scenario: "normal" })
  })
  await suite.test("admin redirect lands on an inert local placeholder even when access is closed", async () => {
    await control({ scenario: "closed401" })
    for (const path of ["/admin", "/admin/"]) {
      const response = await fetch(`${BASE}${path}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get("content-type"), /^text\/html/)
      assert.match(response.headers.get("content-security-policy"), /default-src 'none'/)
      assert.match(response.headers.get("content-security-policy"), /form-action 'none'/)
      const html = await response.text()
      assert.match(html, /MOCK ADMIN/)
      assert.match(html, /\u672c\u5730\u767b\u5f55\u5360\u4f4d/)
      assert.doesNotMatch(html, /<(?:form|input|script|iframe|img|link)\b/i)
      assert.doesNotMatch(html, /(?:src|href|action)\s*=|https?:\/\//i)
    }
    assert.equal((await fetch(`${BASE}/admin/`, { method: "POST" })).status, 405)
    await control({ scenario: "normal" })
  })
  await suite.test("me401 isolates metadata rejection while a former stream keeps sending", async () => {
    const { socket } = await openStream()
    const frame = nextFrame(socket)
    await control({ scenario: "me401" })
    assert.equal((await fetch(`${BASE}/api/me`)).status, 401)
    assert.equal((await fetch(`${BASE}/api/nodes`)).status, 200)
    assert.equal(JSON.parse(await frame).nodes.length, 6)
    socket.close()
    await control({ scenario: "normal" })
  })
  await suite.test("public downgrade ends full streams and exposes only public fixtures", async () => {
    const { socket: former } = await openStream()
    const closed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Full-access WebSocket stayed open")), 3000)
      former.addEventListener("close", () => { clearTimeout(timeout); resolve() }, { once: true })
    })
    await control({ scenario: "publicDowngrade" })
    await closed
    const me = await (await fetch(`${BASE}/api/me`)).json()
    assert.equal(me.authed, false)
    assert.equal(me.public_page, true)
    assert.equal(me.site_name, NORMAL_TITLE)
    const { nodes } = await (await fetch(`${BASE}/api/nodes`)).json()
    assert.deepEqual(nodes.map((node) => node.id), [102, 105])
    assert.ok(nodes.every((node) => node.public === true))
    assert.equal((await fetch(`${BASE}/api/nodes/101/metrics`)).status, 401)
    assert.equal((await fetch(`${BASE}/api/nodes/102/metrics`)).status, 200)
    const { socket, first } = await openStream()
    assert.deepEqual(JSON.parse(first).nodes.map((node) => node.id), [102, 105])
    socket.close()
    await control({ scenario: "normal" })
    assert.equal((await (await fetch(`${BASE}/api/nodes`)).json()).nodes.length, 6)
  })
  await suite.test("removing the selected fixture preserves all other node identities", async () => {
    const { socket } = await openStream()
    const frame = nextFrame(socket)
    await control({ scenario: "removeSelected" })
    const expected = [102, 103, 104, 105, 106]
    assert.deepEqual(JSON.parse(await frame).nodes.map((node) => node.id), expected)
    assert.deepEqual((await (await fetch(`${BASE}/api/nodes`)).json()).nodes.map((node) => node.id), expected)
    assert.equal((await fetch(`${BASE}/api/nodes/101/metrics`)).status, 404)
    assert.equal((await fetch(`${BASE}/api/nodes/102/metrics`)).status, 200)
    assert.equal((await (await fetch(`${BASE}/api/me`)).json()).authed, true)
    socket.close()
    await control({ scenario: "normal" })
  })
  await suite.test("rejects cross-origin control and unknown control properties", async () => {
    const denied = await fetch(`${BASE}/test`, { headers: { Origin: "https://untrusted.example" } })
    assert.equal(denied.status, 403)
    const invalid = await fetch(`${BASE}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "https://untrusted.example" }),
    })
    assert.equal(invalid.status, 400)
  })
})
