import { memo, useEffect, useRef, useState } from "react"
import { api, ApiError, type Node } from "@/lib/api"
import { axisBytes, rate } from "@/lib/format"
import { briefTrace, BRIEF_TTL, createBriefCache, readBriefHistory, type BriefHistory, type BriefPoint } from "@/lib/briefing"
import { stamp } from "./RhineVisuals"
import "./briefing.css"

type Result = { id: number; data?: BriefHistory; loadedAt?: number; error?: string; denied?: boolean }
type Field = Exclude<keyof BriefPoint, "ts">

function Trend({ title, history, fields, format, floor = 1, wide = false }: {
  title: string; history: BriefHistory; fields: { key: Field; label: string; color: string }[]
  format: (value: number) => string; floor?: number; wide?: boolean
}) {
  const max = Math.max(floor, ...history.rows.flatMap((row) => fields.map(({ key }) => row[key] ?? 0)))
  const top = Math.ceil(max * 1.1 / floor) * floor
  const hasData = history.rows.some((row) => fields.some(({ key }) => row[key] !== null))
  return <div className={`brief-trend${wide ? " is-wide" : ""}`}>
    <div className="brief-trend-title"><span>{title}</span>{hasData && <small>0–{format(top)}</small>}</div>
    <svg viewBox="0 0 300 66" preserveAspectRatio="none" role="img" aria-label={`${title}，过去一小时${hasData ? "" : "暂无有效样本"}`}>
      <path className="brief-trend-grid" d="M2 4H298M2 33H298M2 62H298" />
      {fields.map(({ key, color }) => {
        const trace = briefTrace(history, key, top)
        return <g key={key} style={{ color }}>
          <path className="brief-trend-line" d={trace.path} />
          {trace.dots.map(({ x, y }, i) => <circle key={i} cx={x} cy={y} r="1.8" fill="currentColor" />)}
        </g>
      })}
    </svg>
    {!hasData && <span className="brief-trend-empty">暂无有效样本</span>}
    {fields.length > 1 && <div className="brief-trend-legend">{fields.map(({ key, label, color }) =>
      <span key={key}><i style={{ background: color }} />{label}</span>)}</div>}
  </div>
}

export const BriefingTrends = memo(function BriefingTrends({ node, active, stale }: { node: Node; active: boolean; stale: boolean }) {
  const cache = useRef(createBriefCache())
  const [result, setResult] = useState<Result | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [hidden, setHidden] = useState(() => document.hidden)
  const id = node.id
  const enabled = active && !hidden && !stale
  useEffect(() => {
    const visibility = () => setHidden(document.hidden)
    document.addEventListener("visibilitychange", visibility)
    return () => document.removeEventListener("visibilitychange", visibility)
  }, [])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let refresh: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const saved = cache.current.get(id, Date.now())
      if (saved) {
        setResult({ id, ...saved })
        refresh = setTimeout(() => void load(), Math.max(1000, BRIEF_TTL - (Date.now() - saved.loadedAt)))
        return
      }
      try {
        const input = await api<unknown>(`/nodes/${id}/metrics?hours=1&points=120&series=metrics`,
          controller.signal, { timeoutMs: 8000, retries: 0 })
        if (controller.signal.aborted) return
        const loadedAt = Date.now()
        const data = readBriefHistory(input, loadedAt)
        cache.current.set(id, data, loadedAt)
        setResult({ id, data, loadedAt })
        refresh = setTimeout(() => void load(), BRIEF_TTL)
      } catch (error) {
        if (controller.signal.aborted) return
        const denied = error instanceof ApiError && (error.status === 401 || error.status === 403)
        if (denied) cache.current.clear()
        setResult((previous) => ({
          ...(previous?.id === id && !denied ? previous : {}), id, denied,
          error: error instanceof Error ? error.message : "历史数据暂时不可用",
        }))
        if (!denied) refresh = setTimeout(() => void load(), BRIEF_TTL)
      }
    }
    // Wait for a wheel selection to settle before issuing a history request.
    const settle = setTimeout(() => void load(), 240)
    return () => { clearTimeout(settle); clearTimeout(refresh); controller.abort() }
  }, [id, enabled, attempt])
  const current = result?.id === id ? result : null
  const history = current?.data
  const outdated = stale || Boolean(current?.error)
  return <section className={`brief-trends${outdated ? " is-stale" : ""}`} data-testid="brief-trends" data-node-id={id} aria-label={`${node.name} 最近一小时资源趋势`}>
    <div className="brief-trends-head"><span>RESOURCE TRENDS / 资源趋势</span><span>最近 1 小时</span></div>
    {current?.error && <div className="brief-trends-notice" role="status">
      <span>{current.error}{history ? " · 保留上次读取" : ""}</span>
      {!current.denied && enabled && <button className="text-link" onClick={() => { cache.current.clear(); setAttempt((value) => value + 1) }}>重试</button>}
    </div>}
    {history ? <>
      <div className="brief-trends-grid">
        <Trend title="CPU / 处理器" history={history} fields={[{ key: "cpu", label: "CPU", color: "var(--copper)" }]} format={(value) => `${value.toFixed(0)}%`} floor={4} />
        <Trend title="MEMORY / 内存" history={history} fields={[{ key: "mem_used", label: "内存", color: "var(--chart-2)" }]} format={axisBytes} />
        <Trend title="NETWORK / 网络速率" history={history} fields={[{ key: "net_tx", label: "上行", color: "var(--copper)" }, { key: "net_rx", label: "下行", color: "var(--chart-2)" }]} format={rate} wide />
      </div>
      <div className="brief-trends-clock"><span>{stamp(history.from * 1000).slice(0, 5)}</span><span>{outdated ? "上次读取 · " : ""}{stamp(history.to * 1000).slice(0, 5)} UTC+8</span></div>
    </> : !current?.error && <p className="brief-trends-loading" role="status">{stale ? "连接恢复后读取历史" : "正在读取资源趋势…"}</p>}
  </section>
}, (previous, next) => previous.node.id === next.node.id && previous.node.name === next.node.name
  && previous.active === next.active && previous.stale === next.stale)
