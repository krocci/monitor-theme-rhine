import { useEffect, useState } from "react"

export type Metrics = {
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

export type Node = {
  id: number
  name: string
  sort: number
  public: boolean
  online: boolean
  /** ISO 3166-1 alpha-2, or empty when the hub could not locate the address. */
  country: string
  /** Set by the operator; empty is ungrouped. Absent from a hub predating groups. */
  group?: string
  last_seen: number
  /** Seconds since `last_seen` on the hub's clock, null for a node never seen. Absent on older hubs. */
  last_seen_ago?: number | null
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  /**
   * Days until `expires_at` on the hub's calendar, negative once past, null
   * without a date. Absent on older hubs.
   */
  expires_in?: number | null
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  /** This period's usage as the plan meters it (`traffic_mode`). Absent on older hubs. */
  month_used?: number
  month_start: string
  day_rx: number
  day_tx: number
  /** Panel only. */
  hostname?: string
  ip?: string
  remark?: string
}

/** Every group in use, in the order of the first node carrying it: the operator's node order decides the tab order. */
export function groupsOf(nodes: Pick<Node, "group">[]): string[] {
  return [...new Set(nodes.map((n) => n.group ?? "").filter(Boolean))]
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Every error the hub answers is one line of plain text written for the reader.
 * Anything else came from something in front of it -- a proxy's error page, a
 * CDN's challenge, an empty 502 -- and is described by its status instead.
 */
async function failure(res: Response): Promise<ApiError> {
  const text = res.headers.get("content-type")?.startsWith("text/plain") ? (await res.text()).trim() : ""
  return new ApiError(
    res.status,
    text || (res.status >= 500 ? `服务暂时无法访问（HTTP ${res.status}），稍后再试` : `请求被拦截（HTTP ${res.status}），稍后再试`),
  )
}

/**
 * How long one attempt may go unanswered. A connection that died without
 * closing, as when a NAT on a phone's path forgets it, holds a request sent over
 * it until TCP gives up: still pending after 300 s in Chrome over HTTP/1.1,
 * which nginx serves unless configured for HTTP/2. Over HTTP/2 Chrome replaces
 * the dead connection after 10 s itself, but only for a request sent once the
 * connection has been idle 10 s; one sent sooner hangs as over HTTP/1.1.
 * Healthy, the slowest request here, a node's history, answers within 3 s on 4G.
 */
const TIMEOUT = 20_000

/**
 * Further attempts after a timeout. The aborted connection is closed, but the
 * next attempt takes the next idle one, which may be dead as well: Chrome keeps
 * up to six per host, and with four dead the fifth attempt was the first to
 * succeed. Every request here is a GET, so repeating one is safe.
 */
const RETRIES = 6

type RequestPolicy = { timeoutMs?: number; retries?: number }

export async function api<T>(path: string, signal?: AbortSignal, policy: RequestPolicy = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new DOMException("Request timed out", "TimeoutError")), policy.timeoutMs ?? TIMEOUT)
    try {
      const res = await fetch(`/api${path}`, { signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal, cache: "no-store" })
      // Do not wait for a denied response's body before clearing private data.
      if (res.status === 401 || res.status === 403) throw new ApiError(res.status, "需要重新验证访问权限")
      if (!res.ok) throw await failure(res)
      if (res.status === 204) return undefined as T
      // A 200 carrying HTML is a proxy's page, not the hub's JSON.
      return await res.json().catch((e) => {
        throw e instanceof SyntaxError ? new ApiError(res.status, "收到的不是状态数据，稍后再试") : e
      })
    } catch (e) {
      if (signal?.aborted) throw e
      if (e instanceof ApiError) throw e
      // Anything else failed on the network, the body's read included, where
      // the timeout also applies. Chrome names a timeout before the response
      // TimeoutError and one during the body's read AbortError; nothing else
      // here aborts a request except the optional caller cancellation above.
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
      if (!timedOut || attempt === (policy.retries ?? RETRIES)) {
        throw new ApiError(0, "网络连接失败，稍后再试")
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Throughput, one sample per push, as a series for every node (null) and one per
 * group ("" for the ungrouped), so the summary above a group tab draws that
 * group's line rather than the fleet's. Held beside the stream that feeds it
 * rather than in the tile that draws it: the summary unmounts while a node page
 * is open, so a buffer held there would restart empty on every return. Two
 * minutes at the hub's push interval; a group no node carries any more is
 * dropped. Keyed null rather than by any string, since a group may be named
 * anything, "*" included.
 */
const KEEP = 60
export const speedHistory = new Map<string | null, { rx: number; tx: number }[]>()

export function sample(nodes: Node[]) {
  const totals = new Map<string | null, { rx: number; tx: number }>()
  for (const n of nodes) {
    for (const key of [null, n.group ?? ""]) {
      const total = totals.get(key) ?? { rx: 0, tx: 0 }
      if (n.online && n.metrics) {
        total.rx += n.metrics.net_rx
        total.tx += n.metrics.net_tx
      }
      totals.set(key, total)
    }
  }
  for (const key of speedHistory.keys()) if (!totals.has(key)) speedHistory.delete(key)
  for (const [key, total] of totals) {
    const series = speedHistory.get(key) ?? []
    series.push(total)
    if (series.length > KEEP) series.shift()
    speedHistory.set(key, series)
  }
}

/** A malformed report must not remove every other node from the page. */
export function safeNodes(nodes: Node[]): Node[] {
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0
  const fields = ["uptime", "cpu", "mem_total", "mem_used", "swap_total", "swap_used", "disk_total", "disk_used",
    "net_rx", "net_tx", "total_rx", "total_tx", "month_rx", "month_tx", "tcp", "udp", "procs"] as const
  return nodes.map((node) => {
    const m = node.metrics
    return !m || (fields.every((key) => number(m[key])) && Array.isArray(m.load) && m.load.length === 3 && m.load.every(number))
      ? node : { ...node, metrics: null }
  })
}

/**
 * Asks the hub to gzip each pushed frame, sent then as a binary message: a
 * hundred reporting nodes are about 110 KB of JSON every two seconds, 15 KB
 * compressed. Only where the browser can decompress it; a hub that predates the
 * parameter ignores it and sends text, which [frameText] passes through.
 */
const GZIP = typeof DecompressionStream === "function" ? "?gzip" : ""

/** A pushed frame as text: a gzipped one arrives as binary. */
const frameText = (data: string | Blob) =>
  typeof data === "string" ? data : new Response(data.stream().pipeThrough(new DecompressionStream("gzip"))).text()

export type Connection = "connecting" | "live" | "polling" | "stale" | "paused" | "unauthorized"
export type TransportDiagnostics = {
  socketAttempts: number
  socketCloses: number
  socketErrors: number
  socketTimeouts: number
  invalidFrames: number
  httpSuccesses: number
  httpFailures: number
  lastCloseCode: number | null
  lastHttpStatus: number | null
}
export type NodeFeedState = {
  nodes: Node[] | null
  error: string | null
  closed: boolean
  connection: Connection
  /** Local receipt time in milliseconds, not a node's last report time. */
  receivedAt: number | null
  /** Transport counters only. No payloads, credentials, URLs or private node fields. */
  diagnostics: TransportDiagnostics
}

const initialFeed = (): NodeFeedState => ({
  nodes: null, error: null, closed: false, connection: "connecting", receivedAt: null,
  diagnostics: {
    socketAttempts: 0, socketCloses: 0, socketErrors: 0, socketTimeouts: 0,
    invalidFrames: 0, httpSuccesses: 0, httpFailures: 0, lastCloseCode: null, lastHttpStatus: null,
  },
})

const FRESH_MS = 10_000
const STREAM_GRACE_MS = 4000
const POLL_MS = 5000
const POLL_RETRY_MS = 2000
const POLL_TIMEOUT_MS = 4000

/**
 * Shared transport for the hook and deterministic lifecycle tests. Browser
 * connectivity never rewrites a node's hub-reported online/offline status.
 */
export function subscribeNodes(listener: (state: NodeFeedState) => void): () => void {
  let state = initialFeed()
  let socket: WebSocket | null = null
  let poll: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let silent: ReturnType<typeof setTimeout> | null = null
  let freshness: ReturnType<typeof setTimeout> | null = null
  let request: AbortController | null = null
  let disposed = false
  let active = false
  let epoch = 0
  let revision = 0
  let authorizationCheck = 0
  let gap = true
  let socketFailures = 0
  let streamFresh = false

  const publish = (patch: Partial<NodeFeedState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    listener(state)
  }
  const diagnose = (patch: Partial<TransportDiagnostics>) => publish({ diagnostics: { ...state.diagnostics, ...patch } })
  const current = (started: number) => !disposed && active && !state.closed && started === epoch
  const fresh = () => state.receivedAt !== null && Date.now() - state.receivedAt < FRESH_MS
  const watchFreshness = () => {
    if (freshness) clearTimeout(freshness)
    const remaining = state.receivedAt === null ? FRESH_MS : Math.max(0, FRESH_MS - (Date.now() - state.receivedAt))
    freshness = setTimeout(() => {
      freshness = null
      if (disposed || !active || state.closed) return
      gap = true
      publish({ error: "状态数据已过期，正在重新连接", connection: "stale" })
    }, remaining)
  }
  const closeSocket = () => {
    streamFresh = false
    if (silent) clearTimeout(silent)
    silent = null
    if (!socket) return
    const old = socket
    socket = null
    old.onmessage = old.onerror = old.onclose = null
    old.close()
  }
  const disconnect = () => {
    epoch++
    request?.abort()
    request = null
    closeSocket()
    if (poll) clearTimeout(poll)
    if (retry) clearTimeout(retry)
    if (silent) clearTimeout(silent)
    if (freshness) clearTimeout(freshness)
    poll = retry = silent = freshness = null
  }
  const revoke = (message: string) => {
    disconnect()
    speedHistory.clear()
    // Authorization failure is terminal for this subscription. A late decode
    // or successful old GET must not bring a private snapshot back on screen.
    publish({ nodes: null, error: message, closed: true, connection: "unauthorized", receivedAt: null })
  }
  const receive = (list: Node[], connection: "live" | "polling") => {
    if (!Array.isArray(list)) throw new ApiError(200, "收到的不是状态数据，稍后再试")
    const safe = safeNodes(list)
    if (gap || !fresh()) speedHistory.clear()
    gap = false
    revision++
    sample(safe)
    publish({ nodes: safe, error: null, connection, receivedAt: Date.now() })
    watchFreshness()
  }
  const schedulePoll = (delay: number) => {
    if (disposed || !active || state.closed || streamFresh || poll || request) return
    poll = setTimeout(() => {
      poll = null
      fetchOnce()
    }, delay)
  }
  const fetchOnce = () => {
    if (disposed || !active || state.closed || request) return
    if (poll) clearTimeout(poll)
    poll = null
    const started = epoch
    const observed = revision
    const checked = authorizationCheck
    const controller = new AbortController()
    request = controller
    let failed = false
    let accepted = false
    // The feed owns its retries. Do not hold its only HTTP slot through the
    // much longer retry budget used when loading historical charts.
    void api<{ nodes: Node[] }>("/nodes", controller.signal, { timeoutMs: POLL_TIMEOUT_MS, retries: 0 })
      .then((data) => {
        if (!current(started)) return
        diagnose({ httpSuccesses: state.diagnostics.httpSuccesses + 1, lastHttpStatus: 200 })
        // A newer streamed snapshot wins over a slower HTTP response.
        if (observed === revision && checked === authorizationCheck) {
          receive(data.nodes, "polling")
          accepted = true
        }
      })
      .catch((error: Error) => {
        if (!current(started)) return
        failed = true
        diagnose({ httpFailures: state.diagnostics.httpFailures + 1, lastHttpStatus: error instanceof ApiError ? error.status : 0 })
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          revoke(error.message)
          return
        }
        // A failed attempt is not a data outage while a recent snapshot is
        // still available. The independent freshness timer reports real gaps.
        if (state.connection === "stale") publish({ error: error.message })
      })
      .finally(() => {
        if (request !== controller) return
        request = null
        if (!current(started)) return
        // An older GET may have overlapped the final streamed frame. Once the
        // stream ends, re-query. Its own accepted snapshot also increments
        // revision, but must retain the normal polling interval.
        const superseded = (!accepted && observed !== revision) || checked !== authorizationCheck
        schedulePoll(superseded && !streamFresh ? 0 : failed ? POLL_RETRY_MS : POLL_MS)
      })
  }

  const fallback = (recheckAuthorization = false) => {
    streamFresh = false
    if (fresh()) publish({ connection: "polling", error: null })
    // Failed connection attempts must not continually accelerate an already
    // healthy polling cadence. An established stream closing is different.
    if (recheckAuthorization || !poll) fetchOnce()
  }
  const scheduleReconnect = () => {
    if (disposed || !active || state.closed || retry) return
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(socketFailures++, 4))
    retry = setTimeout(() => {
      retry = null
      connect()
    }, delay)
  }
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws${GZIP}`
  const connect = () => {
    if (disposed || !active || state.closed || socket) return
    const started = epoch
    diagnose({ socketAttempts: state.diagnostics.socketAttempts + 1 })
    let opened: WebSocket
    try {
      opened = new WebSocket(url)
    } catch {
      diagnose({ socketErrors: state.diagnostics.socketErrors + 1 })
      fallback()
      scheduleReconnect()
      return
    }
    socket = opened
    let firstFrameAt: number | null = null
    const ownsSocket = () => current(started) && socket === opened
    const watch = () => {
      if (silent) clearTimeout(silent)
      silent = setTimeout(() => {
        if (!ownsSocket()) return
        // Start HTTP recovery after two missed pushes, before data expires.
        fallback()
        silent = setTimeout(() => {
          if (!ownsSocket()) return
          diagnose({ socketTimeouts: state.diagnostics.socketTimeouts + 1 })
          closeSocket()
          fallback()
          scheduleReconnect()
        }, FRESH_MS - STREAM_GRACE_MS)
      }, STREAM_GRACE_MS)
    }
    watch()
    // Decode in arrival order, with ownership checks on both sides of await.
    let decoded = Promise.resolve()
    opened.onmessage = (event) => {
      decoded = decoded
        .then(async () => {
          if (!ownsSocket() || opened.readyState !== WebSocket.OPEN) return
          const nodes = JSON.parse(await frameText(event.data)).nodes
          if (!ownsSocket() || opened.readyState !== WebSocket.OPEN) return
          receive(nodes, "live")
          streamFresh = true
          firstFrameAt ??= Date.now()
          if (Date.now() - firstFrameAt >= 30_000) socketFailures = 0
          watch()
          if (poll) {
            clearTimeout(poll)
            poll = null
          }
        })
        .catch(() => {
          // Malformed frames do not count as activity; the watchdog reconnects.
          if (ownsSocket()) diagnose({ invalidFrames: state.diagnostics.invalidFrames + 1 })
        })
    }
    opened.onerror = () => {
      if (!ownsSocket()) return
      diagnose({ socketErrors: state.diagnostics.socketErrors + 1 })
      // Browser errors have a close event next; the watchdog also covers a
      // non-conforming implementation that never delivers that event.
      opened.close()
    }
    opened.onclose = (event) => {
      if (!ownsSocket()) return
      diagnose({ socketCloses: state.diagnostics.socketCloses + 1, lastCloseCode: event.code })
      const wasStreaming = firstFrameAt !== null
      if (wasStreaming) authorizationCheck++
      closeSocket()
      // Re-query for authorization immediately, while preserving any HTTP
      // request already in flight. A socket retry must not cancel its fallback.
      fallback(wasStreaming)
      scheduleReconnect()
    }
  }

  const pause = () => {
    if (!active && state.connection === "paused") return
    active = false
    disconnect()
    gap = true
    if (!state.closed) publish({ connection: "paused", error: null })
  }
  const resume = () => {
    if (disposed || state.closed || active) return
    disconnect()
    active = true
    publish({ connection: state.nodes === null ? "connecting" : fresh() ? "polling" : "stale", error: null })
    watchFreshness()
    fetchOnce()
    connect()
  }
  const visibility = () => (document.hidden ? pause() : resume())
  document.addEventListener("visibilitychange", visibility)
  visibility()

  return () => {
    disposed = true
    document.removeEventListener("visibilitychange", visibility)
    disconnect()
    speedHistory.clear()
  }
}

/** Live gzip WebSocket snapshots, HTTP fallback and hidden-tab pause. */
export function useNodes(): NodeFeedState {
  const [state, setState] = useState<NodeFeedState>(initialFeed)
  useEffect(() => subscribeNodes(setState), [])
  return state
}
