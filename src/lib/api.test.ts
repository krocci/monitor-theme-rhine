/// <reference types="node" />
import assert from "node:assert/strict"
import { setImmediate as nextTurn } from "node:timers/promises"
import { gzipSync } from "node:zlib"
import { api, groupsOf, safeNodes, sample, speedHistory, subscribeNodes, type Node, type NodeFeedState } from "./api.ts"

const node = { id: 1, metrics: { uptime: 100, cpu: 1, load: [0.1, 0.2, 0.3],
  mem_total: 1024, mem_used: 512, swap_total: 0, swap_used: 0, disk_total: 2048, disk_used: 1024,
  net_rx: 10, net_tx: 20, total_rx: 100, total_tx: 200, month_rx: 50, month_tx: 100,
  tcp: 3, udp: 4, procs: 20 } } as Node
assert.equal(safeNodes([node])[0], node)
for (const patch of [{ load: null }, { load: [1, "bad", 3] }, { cpu: "bad" }, { net_rx: Infinity }]) {
  const bad = { ...node, metrics: { ...node.metrics, ...patch } } as unknown as Node
  const result = safeNodes([bad, node])
  assert.equal(result[0].metrics, null)
  assert.equal(result[1], node)
}
console.log("invalid live reports are isolated")

// Tabs follow the node order; ungrouped nodes and a hub without the field add none.
assert.deepEqual(groupsOf([{ group: "东京" }, { group: "" }, {}, { group: "香港" }, { group: "东京" }]), ["东京", "香港"])
console.log("groups follow the node order")

// Each group keeps its own throughput line beside the fleet's, and a group that
// empties stops being tracked.
const live = (group: string, rx: number) => ({ ...node, group, online: true, metrics: { ...node.metrics!, net_rx: rx, net_tx: 0 } }) as Node
sample([live("东京", 5), live("", 7), { ...live("东京", 9), online: false }])
assert.deepEqual([speedHistory.get(null)?.at(-1)?.rx, speedHistory.get("东京")?.at(-1)?.rx, speedHistory.get("")?.at(-1)?.rx], [12, 5, 7])
sample([live("", 1)])
assert.equal(speedHistory.has("东京"), false)
// A group may be named anything, the fleet's own key included.
sample([live("*", 5), live("", 7)])
assert.deepEqual([speedHistory.get(null)?.at(-1)?.rx, speedHistory.get("*")?.at(-1)?.rx], [12, 5])
console.log("throughput is kept per group")

// A timeout is retried, since the next attempt may take a live connection; a
// read cut off by it reads as a network failure, never as the browser's message.
{
  let calls = 0
  const timeout = () => new DOMException("signal timed out", "TimeoutError")
  globalThis.fetch = async () => {
    if (++calls < 3) throw timeout()
    return { ok: true, status: 200, json: async () => ({ nodes: [] }) } as unknown as Response
  }
  assert.deepEqual(await api("/nodes"), { nodes: [] })
  assert.equal(calls, 3)
  globalThis.fetch = async () => {
    throw timeout()
  }
  await assert.rejects(api("/nodes"), { status: 0, message: "网络连接失败，稍后再试" })
  globalThis.fetch = async () =>
    ({ ok: false, status: 503, headers: new Headers({ "content-type": "text/plain" }), text: async () => { throw new DOMException("aborted", "AbortError") } }) as unknown as Response
  await assert.rejects(api("/nodes"), { status: 0 })
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse("<html>") }) as unknown as Response
  await assert.rejects(api("/nodes"), { status: 200, message: "收到的不是状态数据，稍后再试" })
  for (const status of [401, 403]) {
    globalThis.fetch = async () => ({
      ok: false, status, headers: new Headers({ "content-type": "text/plain" }),
      text: () => { throw new Error("a denied response body must not delay revocation") },
    }) as unknown as Response
    await assert.rejects(api("/nodes"), { status, message: "需要重新验证访问权限" })
  }
  console.log("timeouts are retried and read as network failures")
}

// The transport can be tested without a DOM renderer or contacting a real hub.
function feedHarness(hidden = false, socketUnavailable = false, automaticFallback = false) {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const replace = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  class Page extends EventTarget {
    hidden = hidden
    show(hidden: boolean) {
      this.hidden = hidden
      this.dispatchEvent(new Event("visibilitychange"))
    }
  }
  class Socket {
    static OPEN = 1
    readyState = 0
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    constructor() {
      if (socketUnavailable) throw new Error("fixture WebSocket unavailable")
      sockets.push(this)
      if (automaticFallback) setTimeout(() => this.ended(), 0)
    }
    close() { this.readyState = 3 }
    message(nodes: Node[]) {
      this.readyState = Socket.OPEN
      this.onmessage?.({ data: JSON.stringify({ nodes }) } as MessageEvent)
    }
    ended() {
      this.readyState = 3
      this.onclose?.({ code: 1006 } as CloseEvent)
    }
  }
  const sockets: Socket[] = []
  const requests: { signal: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void; settled: boolean }[] = []
  const timers = new Map<number, { fn: () => void; at: number }>()
  const originalNow = Date.now
  let now = 1_700_000_000_000
  Date.now = () => now
  let timerId = 0
  const schedule = (fn: () => void, delay: number) => {
    timers.set(++timerId, { fn, at: now + delay })
    return timerId
  }
  const page = new Page()
  replace("document", page)
  replace("location", { protocol: "http:", host: "fixture.invalid" })
  replace("WebSocket", Socket)
  replace("fetch", (_path: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    assert.equal(options.cache, "no-store", "fallback snapshots must not come from an HTTP cache")
    const signal = options.signal as AbortSignal
    const request = {
      signal, settled: false,
      resolve(response: Response) { request.settled = true; resolve(response) },
      reject(error: Error) { request.settled = true; reject(error) },
    }
    requests.push(request)
    signal.addEventListener("abort", () => { if (!request.settled) request.reject(signal.reason) }, { once: true })
    if (automaticFallback) queueMicrotask(() => request.resolve(new Response(JSON.stringify({ nodes: [node] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })))
  }))
  replace("setTimeout", schedule)
  replace("clearTimeout", (id: number) => timers.delete(id))
  let state: NodeFeedState | null = null
  const states: NodeFeedState[] = []
  let stopped = false
  const stop = subscribeNodes((next) => { state = next; states.push(next) })
  return {
    sockets, requests, timers, page, states,
    get state(): NodeFeedState { return state! },
    async respond(index: number, nodes: Node[] = [node], status = 200) {
      requests[index].resolve(new Response(status === 200 ? JSON.stringify({ nodes }) : "Access expired", {
        status, headers: { "Content-Type": status === 200 ? "application/json" : "text/plain" },
      }))
      await nextTurn()
    },
    async fail(index: number) {
      requests[index].reject(new TypeError("fixture network unavailable"))
      await nextTurn()
    },
    async advance(ms: number) {
      const until = now + ms
      for (let count = 0; ; count++) {
        assert.ok(count < 1000, "timer loop must stay bounded")
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        now = timer.at
        timers.delete(id)
        timer.fn()
        await nextTurn()
      }
      now = until
      await nextTurn()
    },
    stop() {
      if (stopped) return
      stopped = true
      stop()
    },
    async restore() {
      this.stop()
      await nextTurn()
      Date.now = originalNow
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

const snapshot = (cpu: number) => [{ ...node, online: true, last_seen: 100, metrics: { ...node.metrics!, cpu } }]

{
  const h = feedHarness()
  try {
    assert.equal(h.state.connection, "connecting")
    assert.equal(h.state.receivedAt, null)
    await h.respond(0, snapshot(1))
    assert.equal(h.state.connection, "polling")
    assert.ok(h.state.receivedAt !== null)
    h.sockets[0].message(snapshot(2))
    await nextTurn()
    assert.equal(h.state.connection, "live")
    h.sockets[0].ended()
    assert.equal(h.state.connection, "polling", "a transport handoff does not expire a fresh snapshot")
    assert.equal(h.state.error, null)
    assert.equal(h.state.nodes![0].online, true)
    assert.equal(h.state.nodes![0].metrics!.cpu, 2)
    await h.respond(1, snapshot(3))
    assert.equal(h.state.connection, "polling")
    await h.advance(2000)
    h.sockets[1].message(snapshot(4))
    await nextTurn()
    assert.equal(h.state.connection, "live")
    assert.equal(h.state.nodes![0].metrics!.cpu, 4)
    assert.equal(h.state.diagnostics.socketCloses, 1)
    assert.equal(h.state.diagnostics.lastCloseCode, 1006)
  } finally { await h.restore() }
}

{
  const h = feedHarness()
  try {
    h.sockets[0].message(snapshot(50))
    await nextTurn()
    await h.respond(0, snapshot(1))
    assert.equal(h.state.connection, "live")
    assert.equal(h.state.nodes![0].metrics!.cpu, 50, "late HTTP must not overwrite a newer WebSocket snapshot")
    await h.advance(4000)
    assert.equal(h.state.connection, "polling", "HTTP recovery starts before the freshness deadline")
    assert.equal(h.requests.length, 2)
    await h.advance(6000)
    assert.equal(h.state.connection, "stale")
    assert.equal(h.state.diagnostics.socketTimeouts, 1)
    await h.advance(2000)
    assert.equal(h.sockets.length, 2, "a silent stream is replaced after a bounded backoff")
    assert.equal(h.state.nodes![0].online, true, "transport loss does not mark the node offline")
  } finally { await h.restore() }
}

{
  const h = feedHarness()
  try {
    const oldSocket = h.sockets[0]
    oldSocket.message(snapshot(5))
    await nextTurn()
    const oldMessage = oldSocket.onmessage!
    const oldClose = oldSocket.onclose!
    h.page.show(true)
    await nextTurn()
    assert.equal(h.state.connection, "paused")
    assert.equal(h.requests[0].signal.aborted, true)
    assert.equal(h.timers.size, 0)
    h.page.show(false)
    h.sockets[1].message(snapshot(25))
    await nextTurn()
    await h.respond(0, snapshot(1))
    oldSocket.readyState = 1
    oldMessage({ data: JSON.stringify({ nodes: snapshot(2) }) } as MessageEvent)
    oldClose({ code: 1006 } as CloseEvent)
    await nextTurn()
    assert.equal(h.state.nodes![0].metrics!.cpu, 25)
    assert.equal(h.state.connection, "live")
    h.stop()
    const state = h.state
    await h.respond(1, snapshot(100))
    assert.equal(h.state, state, "unmount must not publish old responses")
  } finally { await h.restore() }
}

{
  const h = feedHarness()
  try {
    h.sockets[0].message(snapshot(10))
    await nextTurn()
    let release!: () => void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => {
          controller.enqueue(gzipSync(JSON.stringify({ nodes: snapshot(99) })))
          controller.close()
        }
      },
    })
    const delayed = new Blob()
    Object.defineProperty(delayed, "stream", { value: () => stream })
    const oldMessage = h.sockets[0].onmessage!
    oldMessage({ data: delayed } as MessageEvent)
    await nextTurn()
    await h.respond(0, [], 401)
    assert.equal(h.state.closed, true)
    assert.equal(h.state.connection, "unauthorized")
    assert.equal(h.state.nodes, null)
    assert.equal(h.state.receivedAt, null)
    assert.equal(speedHistory.size, 0)
    assert.equal(h.timers.size, 0)
    release()
    await nextTurn()
    await nextTurn()
    h.page.show(true)
    h.page.show(false)
    h.sockets[0].readyState = 1
    oldMessage({ data: JSON.stringify({ nodes: snapshot(100) }) } as MessageEvent)
    await nextTurn()
    assert.equal(h.state.nodes, null, "delayed gzip frames cannot restore private data after 401")
    assert.equal(h.state.closed, true)
    assert.equal(h.state.connection, "unauthorized")
    assert.equal(h.requests.length, 1, "revoked subscriptions do not retry without re-authentication")
  } finally { await h.restore() }
}

{
  const h = feedHarness(true)
  try {
    assert.equal(h.state.connection, "paused")
    assert.equal(h.requests.length, 0)
    assert.equal(h.sockets.length, 0)
    h.page.show(false)
    assert.equal(h.requests.length, 1)
    await h.respond(0, [], 403)
    assert.equal(h.state.connection, "unauthorized")
    assert.equal(h.state.nodes, null)
  } finally { await h.restore() }
}

{
  const h = feedHarness()
  try {
    h.sockets[0].message(snapshot(5))
    await nextTurn()
    h.sockets[0].ended()
    assert.equal(h.requests[0].signal.aborted, false, "closing a socket must not abort a viable HTTP fallback")
    assert.equal(h.requests.length, 1)
    await h.advance(2000)
    assert.equal(h.requests.length, 1, "reconnecting does not create overlapping HTTP requests")
    await h.respond(0, snapshot(20))
    assert.equal(h.state.nodes![0].metrics!.cpu, 5, "a GET started before the established stream closed cannot revalidate current authorization")
    await h.advance(0)
    assert.equal(h.requests.length, 2, "a preserved pre-close GET is followed immediately by a post-close authorization check")
    await h.respond(1, snapshot(21))
    assert.equal(h.state.nodes![0].metrics!.cpu, 21)
  } finally { await h.restore() }
}
{
  const h = feedHarness()
  try {
    h.sockets[0].message(snapshot(20))
    await nextTurn()
    await h.fail(0)
    await h.advance(4000)
    h.sockets[0].ended()
    assert.equal(h.requests[1].signal.aborted, false)
    await h.respond(1, [], 403)
    assert.equal(h.state.closed, true)
    assert.equal(h.state.nodes, null, "a fallback denial clears fresh streamed private data")
    assert.equal(h.timers.size, 0)
  } finally { await h.restore() }
}
{
  const h = feedHarness(false, true)
  try {
    await h.respond(0, snapshot(30))
    assert.equal(h.state.connection, "polling")
    await h.advance(5000)
    await h.fail(1)
    assert.equal(h.state.connection, "polling", "a single HTTP failure must not expire a recent snapshot")
    assert.equal(h.state.error, null)
    await h.advance(4999)
    assert.equal(h.state.connection, "polling")
    await h.advance(1)
    assert.equal(h.state.connection, "stale", "both transports failing expires data at ten seconds")
    assert.equal(h.state.nodes![0].online, true)
    const pending = h.requests.findIndex((request) => !request.settled)
    assert.notEqual(pending, -1)
    await h.respond(pending, snapshot(31))
    assert.equal(h.state.connection, "polling")
    assert.equal(h.state.error, null)
  } finally { await h.restore() }
}
{
  const h = feedHarness(false, true)
  try {
    await h.advance(3999)
    assert.equal(h.requests[0].signal.aborted, false)
    await h.advance(1)
    assert.equal(h.requests[0].signal.aborted, true, "a hung live-data GET is bounded to four seconds")
    assert.equal(h.state.diagnostics.httpFailures, 1)
    assert.equal(h.requests.length, 1)
    await h.advance(2000)
    assert.equal(h.requests.length, 2, "a failed request releases its slot for a fresh attempt")
    await h.respond(1, snapshot(32))
    assert.equal(h.state.connection, "polling")
  } finally { await h.restore() }
}
{
  const h = feedHarness()
  try {
    await h.respond(0, snapshot(10))
    h.sockets[0].message(snapshot(20))
    await nextTurn()
    const oldMessage = h.sockets[0].onmessage!
    h.sockets[0].ended()
    await h.advance(2000)
    h.sockets[1].message(snapshot(30))
    await nextTurn()
    h.sockets[0].readyState = 1
    oldMessage({ data: JSON.stringify({ nodes: snapshot(99) }) } as MessageEvent)
    await nextTurn()
    assert.equal(h.state.nodes![0].metrics!.cpu, 30, "replaced sockets cannot publish within the same visible-tab lifetime")
    const requests = h.requests.length
    const sockets = h.sockets.length
    h.page.show(false)
    assert.equal(h.requests.length, requests, "duplicate visibility events do not restart a healthy feed")
    assert.equal(h.sockets.length, sockets)
  } finally { await h.restore() }
}
{
  const h = feedHarness()
  try {
    await h.respond(0, snapshot(1))
    for (let second = 1; second <= 120; second++) {
      await h.advance(1000)
      const socket = h.sockets.at(-1)!
      if (socket.readyState === 0) {
        socket.message(snapshot(second))
        await nextTurn()
      }
      if (second % 3 === 0 && socket.readyState === 1) socket.ended()
      for (let index = 0; index < h.requests.length; index++) {
        if (!h.requests[index].settled) await h.respond(index, snapshot(second))
      }
    }
    assert.ok(h.state.diagnostics.socketCloses > 4, "fixture must actually flap its WebSockets")
    assert.ok(h.state.diagnostics.httpSuccesses > 10, "HTTP must carry the feed through the flapping")
    assert.ok(h.state.diagnostics.httpSuccesses <= 35, "two minutes of flapping must keep a bounded HTTP cadence")
    assert.ok(h.state.diagnostics.socketAttempts < 12, "one-frame sockets do not reset reconnect backoff")
    assert.equal(h.states.some((state) => state.connection === "stale"), false, "fresh HTTP snapshots stay available across two minutes of socket flapping")
    assert.equal(h.states.some((state) => state.error !== null), false)
  } finally { await h.restore() }
}
{
  const h = feedHarness(false, false, true)
  try {
    await h.advance(0)
    assert.equal(h.requests.length, 1)
    await h.advance(4999)
    assert.equal(h.requests.length, 1, "a successful HTTP response must not schedule its own zero-delay successor")
    await h.advance(1)
    assert.equal(h.requests.length, 2)
    await h.advance(25_000)
    assert.equal(h.requests.length, 7, "permanent wsdrop makes one initial GET plus six polls in thirty seconds")
    await h.advance(90_000)
    assert.equal(h.requests.length, 25, "two minutes of immediate successful HTTP fallback stay at five-second intervals")
    assert.ok(h.state.diagnostics.httpSuccesses <= 35)
    assert.ok(h.state.diagnostics.socketCloses >= 5, "fixture must repeatedly fail WebSocket handshakes")
    assert.equal(h.states.some((state) => state.connection === "stale"), false)
    assert.equal(h.states.some((state) => state.error !== null), false)
  } finally { await h.restore() }
}
console.log("node transport preserves fresh fallback during socket flapping, bounds hung requests, expires real gaps and fails closed on authorization loss")
