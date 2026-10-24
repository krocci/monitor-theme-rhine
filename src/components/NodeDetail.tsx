import { memo, useEffect, useId, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import {
  Area, AreaChart, Brush, CartesianGrid, ComposedChart, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis, usePlotArea, useXAxisScale, useYAxisScale, type DotItemDotProps,
} from "recharts"

import { api, type Node } from "@/lib/api"
import {
  axisBytes, axisTop, bytes, clockFor, quarters, rate, RATE_FLOOR,
  rateAxis, tickClock, timeTicks, windows, withGaps,
} from "@/lib/format"
import {
  buildPingPaths, nearestTimeIndex, pingSampleAt, preparePingHistory, selectPingWindow,
  type PingPoint, type PingSeries,
} from "@/lib/history"
import "./history.css"

type Point = {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
  // The highest rate the agent measured over one report interval within the
  // bucket, never below its mean. Absent from hubs predating it.
  net_rx_max?: number
  net_tx_max?: number
}
/** Assigned probe names; an empty map can also mean their lookup failed. */
type Probes = Record<string, string>
/**
 * Proportion of the whole window each probe lost, by id, absent for probes that
 * lost nothing. Sent because it cannot be derived here: every bucket's `loss` is
 * already a percentage of that bucket, so the sample counts it was divided by are
 * unavailable. Averaging them would weight a bucket holding one sample equally
 * with one holding twelve, and the window's first and last buckets are partial
 * regardless of what the probe does.
 */
type Loss = Record<string, number>

type HistoryData = { metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss }
type HistoryMode = "resources" | "latency"
type HistoryProps = { node: Node; historyDays: number; mode: HistoryMode }
type ProbeHistory = {
  id: number
  name: string
  points: PingPoint[]
  loss: number | null
}

const HISTORY_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})
const SAMPLE_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
})

const AXIS = { stroke: "currentColor", fontSize: 11, tickLine: false, axisLine: false }

// No grow-in animation: it would spend 1.5 s drawing a line across the panel on
// every range change, on a page meant to be read at a glance, and on the latency
// chart across seven hundred points per probe.
const SERIES = { dot: false as const, strokeWidth: 1.5, isAnimationActive: false }

// A resource chart's series. A row with a gap on either side has no neighbour to
// draw a line to, so it is marked with a dot; without one, a node back for a
// single bucket after a stretch offline would not show at all.
const RESOURCE_SERIES = {
  ...SERIES,
  dot: ({ cx, cy, index, points, stroke }: DotItemDotProps) =>
    cy == null || points[index - 1]?.y != null || points[index + 1]?.y != null ? null : (
      <circle cx={cx} cy={cy} r={2} fill={stroke} />
    ),
}

// Nor does the tooltip slide. Entering a chart at its right edge, it appears
// beside the cursor first and would glide 400 ms back within the chart,
// overhanging the page by up to 140 px and flashing a horizontal scrollbar.
const TOOLTIP = {
  isAnimationActive: false,
  labelFormatter: (ts: unknown) => `${HISTORY_TIME.format(Number(ts))} (UTC+8)`,
  contentStyle: {
    fontSize: 12,
    borderRadius: 0,
    background: "var(--color-background)",
    borderColor: "var(--color-border)",
    color: "var(--color-foreground)",
    maxWidth: "min(28rem, 85vw)",
  },
}

// One width for every stacked panel's value axis. Sized to their own labels --
// 40px under "100%", 68px under "172 MB" -- the four plot areas would be offset by
// 28px, placing a CPU spike and the network spike that caused it at different x.
//
// Every listed tick is drawn: the lists are spaced to fit, while recharts' own
// collision pass would nudge the top label 5 px inward, drop the tick beneath it,
// and thin the gridlines separately -- the CPU axis would lose its 30% gridline,
// and a rate axis of 1 KB/s to 100 MB/s its 10 MB/s label and two gridlines.
const VALUE_AXIS = { ...AXIS, width: 68, interval: 0 }

const PALETTE = [
  "#a05e32",
  "#267984",
  "#617a35",
  "#97791d",
  "#805b87",
  "#3b65a0",
  "#b24d61",
]

function historyTimeAxis(from: number, to: number, hours: number, count = 6) {
  const ticks = timeTicks(from, to, count)
  return {
    dataKey: "ts",
    type: "number" as const,
    domain: ["dataMin", "dataMax"] as const,
    ticks,
    tickFormatter: tickClock(ticks, hours),
    minTickGap: hours > 24 ? 64 : 32,
    height: 25,
    ...AXIS,
  }
}

const LatencyPaths = memo(function LatencyPaths({ series, from, to, smooth, colors, highlighted }: {
  series: PingSeries[]
  from: number
  to: number
  smooth: boolean
  colors: Map<number, string>
  highlighted: number | null
}) {
  const plot = usePlotArea()
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  const clip = useId()
  const paths = useMemo(() => {
    if (!plot || !xScale || !yScale) return []
    return series.map((probe) => ({
      id: probe.id,
      ...buildPingPaths(probe.samples, from, to, plot.width, (ts) => xScale(ts) ?? 0, (value) => yScale(value) ?? 0, smooth),
    }))
  }, [series, from, to, smooth, plot, xScale, yScale])
  if (!plot) return null
  return (
    <g aria-hidden="true" className="rhine-latency-paths" data-probe-count={series.length}>
      <defs><clipPath id={clip}><rect x={plot.x - 3} y={plot.y - 3} width={plot.width + 6} height={plot.height + 6} /></clipPath></defs>
      <g clipPath={`url(#${clip})`}>
        {paths.map((path) => (
          <g key={path.id} className="rhine-latency-series" data-probe-id={path.id} data-rendered-vertices={path.vertices}>
            <path d={path.band} fill={colors.get(path.id)} fillOpacity={highlighted === path.id || series.length === 1 ? 0.12 : 0.04} />
            <path
              className="rhine-latency-line"
              d={path.line}
              fill="none"
              stroke={colors.get(path.id)}
              strokeOpacity={highlighted === null || highlighted === path.id ? 1 : 0.25}
              strokeWidth={highlighted === path.id ? 2.5 : 1.8}
              strokeLinejoin="round"
            />
            <path d={path.dots} fill={colors.get(path.id)} fillOpacity={highlighted === null || highlighted === path.id ? 1 : 0.25} />
          </g>
        ))}
      </g>
    </g>
  )
})

function LatencyCursor({ rows, series, probes, fromIndex, toIndex, from, to, colors, smooth, tooltipHost }: {
  rows: { ts: number }[]
  series: PingSeries[]
  probes: ProbeHistory[]
  fromIndex: number
  toIndex: number
  from: number
  to: number
  colors: Map<number, string>
  smooth: boolean
  tooltipHost: HTMLDivElement | null
}) {
  const [cursor, setCursor] = useState<number | null>(null)
  const tooltipId = useId()
  const plot = usePlotArea()
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  if (!plot || !xScale || !yScale) return null
  const index = cursor === null ? null : Math.max(fromIndex, Math.min(toIndex, cursor))
  const ts = index === null ? null : rows[index]?.ts ?? null
  const hits = ts === null ? [] : series.map((probe) => ({
    id: probe.id,
    name: probes.find((item) => item.id === probe.id)?.name ?? String(probe.id),
    sample: pingSampleAt(probe, ts, from, to),
  }))
  const cursorX = ts === null ? plot.x : xScale(ts) ?? plot.x
  const tooltipWidth = Math.min(390, plot.width)
  const tooltipX = Math.max(plot.x, Math.min(plot.x + plot.width - tooltipWidth, cursorX + 12))
  return (
    <g className="rhine-latency-cursor">
      <rect
        x={plot.x} y={plot.y} width={plot.width} height={plot.height}
        fill="transparent"
        className="rhine-latency-hit-area"
        tabIndex={0}
        role="slider"
        aria-label="查看延迟采样，左右方向键切换"
        aria-valuemin={rows[fromIndex]?.ts}
        aria-valuemax={rows[toIndex]?.ts}
        aria-valuenow={ts ?? rows[fromIndex]?.ts}
        aria-valuetext={ts === null ? undefined : HISTORY_TIME.format(ts)}
        aria-describedby={ts === null ? undefined : tooltipId}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          if (bounds.width <= 0) return
          const time = from + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (to - from)
          setCursor(nearestTimeIndex(rows, time, fromIndex, toIndex))
        }}
        onPointerLeave={(event) => {
          if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest(".rhine-latency-tooltip")) setCursor(null)
        }}
        onMouseMove={(event) => event.stopPropagation()}
        onTouchMove={(event) => event.stopPropagation()}
        onFocus={() => setCursor(fromIndex)}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest(".rhine-latency-tooltip")) setCursor(null)
        }}
        onKeyDown={(event) => {
          const current = index ?? fromIndex
          const next = event.key === "ArrowLeft" ? Math.max(fromIndex, current - 1)
            : event.key === "ArrowRight" ? Math.min(toIndex, current + 1)
              : event.key === "Home" ? fromIndex : event.key === "End" ? toIndex : null
          if (next !== null) { event.preventDefault(); setCursor(next) }
          else if (event.key === "Escape") setCursor(null)
        }}
      />
      {ts !== null && (
        <g pointerEvents="none">
          <line x1={cursorX} x2={cursorX} y1={plot.y} y2={plot.y + plot.height} stroke="var(--color-border)" />
          {hits.map(({ id, sample }) => {
            const value = sample && (smooth ? sample.filtered : sample.value)
            return sample && value !== null && value !== undefined
              ? <circle key={id} cx={xScale(sample.ts)} cy={yScale(value)} r={3} fill={colors.get(id)} stroke="var(--color-background)" />
              : null
          })}
        </g>
      )}
      {ts !== null && tooltipHost && createPortal(
            <div
              id={tooltipId}
              className="rhine-latency-tooltip"
              role="tooltip"
              tabIndex={0}
              style={{ left: tooltipX, top: plot.y, width: tooltipWidth, maxHeight: Math.max(80, plot.height) }}
              onPointerLeave={() => setCursor(null)}
              onBlur={() => setCursor(null)}
              onMouseMove={(event) => event.stopPropagation()}
            >
              <div className="rhine-latency-tooltip-time">{HISTORY_TIME.format(ts)} · UTC+8</div>
              {hits.map(({ id, name, sample }) => (
                <div className="rhine-latency-tooltip-row" key={id}>
                  <span style={{ color: colors.get(id) }}>{name}</span>
                  <time title={sample ? HISTORY_TIME.format(sample.ts) : undefined}>{sample ? SAMPLE_TIME.format(sample.ts) : "—"}</time>
                  <span>
                    {!sample ? "暂无样本" : sample.value === null ? "未应答" : `${Math.round(smooth ? sample.filtered ?? sample.value : sample.value)} ms`}
                    {sample && sample.loss > 0 ? ` · 丢 ${sample.loss < 1 ? "<1" : Math.round(sample.loss)}%` : ""}
                    {smooth && sample?.value !== null && sample?.filtered !== sample?.value && (
                      <small>原始 {Math.round(sample!.value!)} ms</small>
                    )}
                  </span>
                </div>
              ))}
            </div>
        , tooltipHost)}
    </g>
  )
}

const LatencyChart = memo(function LatencyChart({ probes, hours, smooth }: {
  probes: ProbeHistory[]
  hours: number
  smooth: boolean
}) {
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const [hidden, setHidden] = useState<Set<number>>(() => new Set())
  const [highlighted, setHighlighted] = useState<number | null>(null)
  const [tooltipHost, setTooltipHost] = useState<HTMLDivElement | null>(null)
  const { rows, series } = useMemo(() => preparePingHistory(probes), [probes])
  const colors = useMemo(() => new Map(probes.map((probe, index) => [probe.id, PALETTE[index % PALETTE.length]])), [probes])
  const fromIndex = Math.min(zoom?.[0] ?? 0, Math.max(0, rows.length - 1))
  const toIndex = Math.min(zoom?.[1] ?? rows.length - 1, Math.max(0, rows.length - 1))
  const from = rows[fromIndex]?.ts ?? 0
  const to = rows[toIndex]?.ts ?? 0
  const domain: [number, number] = from === to ? [from - 30_000, to + 30_000] : [from, to]
  const visible = useMemo(() => series.filter((probe) => !hidden.has(probe.id)), [series, hidden])
  const activeHighlight = highlighted !== null && !hidden.has(highlighted) ? highlighted : null
  const window = useMemo(() => selectPingWindow(visible, from, to, smooth), [visible, from, to, smooth])
  const emptyText = visible.length === 0
    ? "选择图例中的探测以显示曲线"
    : window.hasSamples
      ? "所选探测此时段均未应答"
      : "所选探测此时段暂无样本"

  return (
    <section className="rhine-latency-panel" aria-label="探测延迟同图对比">
      <div className="rhine-latency-heading">
        <h3>探测延迟 <span>同图对比</span></h3>
        {hidden.size > 0 && (
          <button type="button" onClick={() => setHidden(new Set())}>显示全部</button>
        )}
      </div>
      <div className="rhine-probe-legend" role="group" aria-label="探测图例，点击切换显示">
        {probes.map((probe) => (
          <button
            key={probe.id}
            type="button"
            className={`rhine-probe-toggle${hidden.has(probe.id) ? " is-hidden" : ""}`}
            aria-pressed={!hidden.has(probe.id)}
            onClick={() => setHidden((previous) => {
              const next = new Set(previous)
              if (next.has(probe.id)) next.delete(probe.id)
              else next.add(probe.id)
              return next
            })}
            onMouseEnter={() => setHighlighted(probe.id)}
            onMouseLeave={() => setHighlighted(null)}
            onFocus={() => setHighlighted(probe.id)}
            onBlur={() => setHighlighted(null)}
          >
            <span className="rhine-probe-swatch" style={{ backgroundColor: colors.get(probe.id) }} aria-hidden />
            <span className="rhine-probe-label">
              <span className="rhine-probe-name">{probe.name}</span>
              <span className="rhine-probe-status">
                {probe.points.length === 0 ? "暂无样本 · " : !series.find((item) => item.id === probe.id)?.answers ? "均未应答 · " : ""}
                <span className={probe.loss !== null && probe.loss > 0 ? "rhine-probe-loss has-loss" : "rhine-probe-loss"}>
                  {probe.loss === null ? "窗口丢包 —" : `窗口丢包 ${probe.loss > 0 && probe.loss < 1 ? "<1" : Math.round(probe.loss)}%`}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="rhine-history-plot is-latency" ref={setTooltipHost}>
        {rows.length === 0 ? (
          <p className="rhine-history-message" role="status">此时段暂无样本</p>
        ) : (
          <ResponsiveContainer>
            <ComposedChart data={rows} margin={{ top: 5, right: 8, bottom: 0, left: 0 }} accessibilityLayer={false}>
              <CartesianGrid className="stroke-border" vertical={false} />
              <XAxis {...historyTimeAxis(domain[0], domain[1], hours, 8)} domain={domain} allowDataOverflow />
              <YAxis
                {...AXIS}
                width={55}
                unit="ms"
                tickCount={5}
                allowDecimals={false}
                domain={window.domain}
                allowDataOverflow
              />
              <LatencyPaths
                series={window.series}
                from={domain[0]} to={domain[1]} smooth={smooth}
                colors={colors} highlighted={activeHighlight}
              />
              <LatencyCursor
                rows={rows} series={window.series} probes={probes}
                fromIndex={fromIndex} toIndex={toIndex} from={domain[0]} to={domain[1]}
                colors={colors} smooth={smooth} tooltipHost={tooltipHost}
              />
              {rows.length > 1 && (
                <Brush
                  dataKey="ts"
                  height={18}
                  travellerWidth={8}
                  tickFormatter={clockFor(hours)}
                  className="fill-muted"
                  stroke="var(--color-muted-foreground)"
                  startIndex={fromIndex}
                  endIndex={toIndex}
                  onChange={(range) => setZoom([range.startIndex ?? 0, range.endIndex ?? rows.length - 1])}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        {rows.length > 0 && !window.hasAnswers && (
          <p className="rhine-latency-empty" role="status">{emptyText}</p>
        )}
      </div>
    </section>
  )
})

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rhine-history-panel">
      <h3>{title}</h3>
      <div className="rhine-history-plot">{children}</div>
    </section>
  )
}

function RangeButton({ active, onClick, children }: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={active ? "is-active" : undefined}
    >
      {children}
    </button>
  )
}

/**
 * `historyDays` is how far back the hub keeps history. Both tabs offer every
 * window within it: up to a day each ping is on the latency chart, and past it a
 * point is a bucket -- its median, the range its answers spanned and the share
 * lost -- which over a month shows a route's evening pattern a day cannot.
 */
export const NodeHistory = memo(function NodeHistory({ node, historyDays, mode }: HistoryProps) {
  const ranges = useMemo(() => windows(historyDays), [historyDays])
  const [picked, setPicked] = useState({ resources: 6, latency: 6 })
  const hours = ranges.some((r) => r.hours === picked[mode]) ? picked[mode] : ranges[0].hours
  const [attempt, setAttempt] = useState(0)

  return (
    <section className="rhine-history" aria-label={mode === "latency" ? "网络探测历史" : "资源历史"}>
      <div className="rhine-history-toolbar">
        <div className="rhine-range" role="group" aria-label="历史时间范围">
          {ranges.map((r) => (
            <RangeButton
              key={r.hours}
              active={hours === r.hours}
              onClick={() => setPicked((all) => ({ ...all, [mode]: r.hours }))}
            >
              {r.label}
            </RangeButton>
          ))}
        </div>
        <button type="button" className="rhine-history-refresh" onClick={() => setAttempt((n) => n + 1)}>
          刷新历史
        </button>
      </div>
      {/* A changed identity mounts empty, before effects run. Old-node results
          must never appear even for one render under the new node's heading. */}
      <HistoryWindow
        key={`${node.id}:${mode}:${hours}:${attempt}`}
        node={node}
        mode={mode}
        hours={hours}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    </section>
  )
}, (previous, next) =>
  previous.node.id === next.node.id
  && previous.node.mem_total === next.node.mem_total
  && previous.node.disk_total === next.node.disk_total
  && previous.historyDays === next.historyDays
  && previous.mode === next.mode)

function HistoryWindow({ node, mode, hours, onRetry }: {
  node: Node
  mode: HistoryMode
  hours: number
  onRetry: () => void
}) {
  const [smooth, setSmooth] = useState(false)
  const [data, setData] = useState<HistoryData | null>(null)
  // Retained rather than folded into an empty result: a refused request and an
  // empty window are different answers, and the hub has reason to refuse this one
  // -- it caps how many history windows it builds concurrently. Rendered as an
  // empty window, a 503 would misdirect the reader.
  const [failed, setFailed] = useState("")
  const [loadedAt, setLoadedAt] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    // What this screen can resolve, in device pixels, which is the unit the line
    // is drawn in: a 1280-wide retina panel has 2560 of them for a day of minutes.
    // Read here rather than from a ref, since the hub only thins further, an
    // approximate figure suffices, and the viewport is known before layout. A
    // rotation keeps whatever it fetched with.
    //
    // The tab determines which half is requested; the other accounted for a third
    // to two thirds of every response and was never drawn.
    const points = Math.max(320, Math.round(globalThis.innerWidth * (globalThis.devicePixelRatio || 1)))
    const series = mode === "latency" ? "ping" : "metrics"
    api<HistoryData>(
      `/nodes/${node.id}/metrics?hours=${hours}&points=${points}&series=${series}`,
      controller.signal,
    )
      .then((next) => {
        if (!next || !Array.isArray(next.metrics) || !Array.isArray(next.ping)) {
          throw new Error("历史接口未返回可识别的数据格式")
        }
        if (active) {
          setData(next)
          setLoadedAt(Date.now())
        }
      })
      .catch((e: unknown) => {
        if (active) setFailed(e instanceof Error ? e.message : "请求未成功完成")
      })
    return () => { active = false; controller.abort() }
  }, [node.id, hours, mode])

  const pingSeries = useMemo<ProbeHistory[]>(
    () =>
      [...new Set([
        ...(data?.ping ?? []).map((p) => p.task_id),
        ...Object.keys(data?.probes ?? {}).map(Number).filter(Number.isFinite),
      ])]
        .sort((a, b) => a - b)
        .map((id) => {
          // Timeouts are retained: dropping them would draw a probe losing half
          // its packets as an unbroken line, and one that never answered not at
          // all.
          const points = (data?.ping ?? []).filter((p) => p.task_id === id)
          // Taken from the hub rather than summed from the buckets above, each of
          // which is already a percentage of its own bucket, so averaging them
          // would report one lost round in thirteen as 50%. Left unrounded, since
          // `Math.round` would render 0.28% and 0.00% as the same badge, and the
          // absent entry denotes no loss only when the hub sent the loss map.
          const loss = data?.loss === undefined || points.length === 0 ? null : data.loss[id] ?? 0
          return { id, name: data?.probes?.[id] ?? `探测 ${id}`, points, loss }
        }),
    [data],
  )

  // The hub answers in seconds; the time axis requires milliseconds. Each rate
  // also spans from its mean to its peak, which is the band drawn behind the
  // line; without a peak the band has no height. The rates drawn are lifted to
  // the floor of their log axis, which has no zero, while `net_rx` and `net_tx`
  // keep the hub's figures for the tooltip.
  const metricRows = useMemo(() => {
    const lift = (v: number) => Math.max(v, RATE_FLOOR)
    return (data?.metrics ?? []).map((p) => ({
      ...p,
      ts: p.ts * 1_000,
      rx: lift(p.net_rx),
      tx: lift(p.net_tx),
      rx_band: [lift(p.net_rx), lift(p.net_rx_max ?? p.net_rx)],
      tx_band: [lift(p.net_tx), lift(p.net_tx_max ?? p.net_tx)],
    }))
  }, [data])
  // What the four panels draw: the rows above, broken where the node was silent.
  // The axes are fitted to the rows alone.
  const chartRows = useMemo(() => withGaps(metricRows), [metricRows])
  // The window's highest rate each way, or null from a hub that sends no peak:
  // a maximum of the means would be labelled a peak it is not.
  const peak = useMemo(() => {
    const rows = data?.metrics ?? []
    if (!rows.some((m) => m.net_rx_max !== undefined)) return null
    const max = (pick: (m: Point) => number | undefined) => rows.reduce((hi, m) => Math.max(hi, pick(m) ?? 0), 0)
    return { rx: max((m) => m.net_rx_max), tx: max((m) => m.net_tx_max) }
  }, [data])

  // Axes for the two panels with no capacity to measure against. CPU and a
  // transfer rate do not express fullness: against a fixed 0-100, a machine
  // sitting at 0.4% draws as a line along the panel's floor. Memory and disk keep
  // their totals as tops, where fullness is the entire question.
  const axes = useMemo(() => {
    const max = (pick: (m: (typeof metricRows)[number]) => number) =>
      metricRows.reduce((hi, m) => Math.max(hi, pick(m)), 0)
    // A floor of 4%, or a machine that never exceeds 0.4% would get an axis of
    // 0-0.4 and render every scheduler blip as a peak. Capped at 100.
    const cpu = axisTop(max((m) => m.cpu), 4, 100)
    return {
      cpu: { domain: [0, cpu], ticks: quarters(cpu) },
      // From the slowest rate drawn to the highest peak, so the band stays
      // within the panel.
      rate: rateAxis(
        metricRows.reduce((lo, m) => Math.min(lo, m.rx, m.tx), Infinity),
        max((m) => Math.max(m.rx_band[1], m.tx_band[1])),
      ),
    }
  }, [metricRows])

  // A real time axis rather than the category axis recharts defaults to: on a
  // category axis ticks are selected by index, so a period the agent was offline
  // for collapses to nothing.
  const timeAxis = (rows: { ts: number }[], from = 0, to = rows.length - 1) => {
    // Explicit, or recharts places them at 05:14 and 10:22. Any that still collide
    // are dropped by `minTickGap`.
    return historyTimeAxis(rows[from]?.ts ?? 0, rows[to]?.ts ?? 0, hours)
  }

  return (
    <div className="rhine-history-content">
      <div className="rhine-history-meta">
        <span>
          {loadedAt ? `读取于 ${HISTORY_TIME.format(loadedAt)}` : "历史数据"}
          {" · UTC+8"}
        </span>
        {mode === "latency" && (
          <div className="rhine-network-controls">
            <label className="rhine-history-smooth">
              <input
                type="checkbox"
                checked={smooth}
                onChange={(e) => setSmooth(e.target.checked)}
              />
              削峰显示
            </label>
          </div>
        )}
      </div>

      {failed ? (
        <p className="rhine-history-message is-error" role="alert">
          读取历史数据失败：{failed}
          <button type="button" onClick={onRetry}>重试</button>
        </p>
      ) : !data ? (
        <p className="rhine-history-message" role="status">正在读取历史数据…</p>
      ) : mode === "latency" ? (
        pingSeries.length === 0 ? (
          <p className="rhine-history-message" role="status">此时段暂无探测样本</p>
        ) : (
          <LatencyChart probes={pingSeries} hours={hours} smooth={smooth} />
        )
      ) : data.metrics.length === 0 ? (
        <p className="rhine-history-message" role="status">此时段暂无资源样本</p>
      ) : (
        <div className="rhine-history-panels">
          <Panel title="CPU">
            <ResponsiveContainer>
              <AreaChart data={chartRows}>
                <CartesianGrid className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(chartRows)} />
                <YAxis {...axes.cpu} unit="%" {...VALUE_AXIS} />
                <Tooltip {...TOOLTIP} formatter={(v) => [`${Number(v).toFixed(1)}%`, "CPU"]} />
                <Area dataKey="cpu" stroke="var(--color-chart-1)" fill="var(--color-chart-1)" fillOpacity={0.15} {...RESOURCE_SERIES} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* The axis top is the machine's memory, so the line's height is the
              fraction in use whatever range is picked. Tracking the window's
              own maximum, which is what an area chart does by default, puts
              127 MB of a 457 MB box at the top of the panel. The size is in the
              title because the axis top is claiming it. */}
          <Panel title={`内存 · ${node.mem_total > 0 ? bytes(node.mem_total) : "总量未知"}`}>
            <ResponsiveContainer>
              <AreaChart data={chartRows}>
                <CartesianGrid className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(chartRows)} />
                <YAxis domain={[0, node.mem_total > 0 ? node.mem_total : "auto"]} ticks={node.mem_total > 0 ? quarters(node.mem_total) : undefined} tickFormatter={axisBytes} {...VALUE_AXIS} />
                <Tooltip {...TOOLTIP} formatter={(v) => bytes(Number(v))} />
                <Area dataKey="mem_used" name="内存" stroke="var(--color-chart-2)" fill="var(--color-chart-2)" fillOpacity={0.15} {...RESOURCE_SERIES} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* A rate has no total to be a fraction of, and its range spans orders
              of magnitude: a week of one node runs from 0.2 KB/s idle to bursts
              of 70 MB/s. Fitted to the bursts, a linear axis would draw the
              median minute less than a pixel above the floor on seven of nine
              nodes at the day window, so this one is logarithmic, each tenfold
              step the same height.

              The line is the bucket's mean, so it integrates to the traffic
              totals, and a 15-second speed test averaged over its minute draws
              at a quarter of the rate it ran at. The band behind it reaches the
              highest rate measured within the bucket. */}
          <Panel title={peak ? `网络速率 · 峰值 ↓ ${rate(peak.rx)} · ↑ ${rate(peak.tx)}` : "网络速率"}>
            <ResponsiveContainer>
              <ComposedChart data={chartRows}>
                <CartesianGrid className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(chartRows)} />
                <YAxis scale="log" {...axes.rate} tickFormatter={axisBytes} unit="/s" {...VALUE_AXIS} />
                <Tooltip
                  {...TOOLTIP}
                  // The hub's figures rather than `v`, which is lifted to the
                  // axis floor.
                  formatter={(_, name, item) => {
                    const mean = item?.payload?.[`net_${item.dataKey}`]
                    const top = item?.payload?.[`net_${item.dataKey}_max`]
                    return [top === undefined ? rate(mean) : `均值 ${rate(mean)} · 峰值 ${rate(top)}`, name]
                  }}
                />
                {[
                  { key: "rx", stroke: "var(--color-ok)" },
                  { key: "tx", stroke: "var(--color-chart-1)" },
                ].map((s) => (
                  <Area
                    key={s.key}
                    dataKey={`${s.key}_band`}
                    stroke="none"
                    fill={s.stroke}
                    fillOpacity={0.16}
                    isAnimationActive={false}
                    tooltipType="none"
                    legendType="none"
                  />
                ))}
                <Line dataKey="rx" name="下行" stroke="var(--color-ok)" {...RESOURCE_SERIES} />
                <Line dataKey="tx" name="上行" stroke="var(--color-chart-1)" {...RESOURCE_SERIES} />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>

          {/* The disk it is filling, for the same reason as memory: a node
              using 2.7% of its disk draws along the top of the panel when the
              axis tracks the window's own maximum. */}
          <Panel title={`硬盘 · ${node.disk_total > 0 ? bytes(node.disk_total) : "总量未知"}`}>
            <ResponsiveContainer>
              <AreaChart data={chartRows}>
                <CartesianGrid className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(chartRows)} />
                <YAxis domain={[0, node.disk_total > 0 ? node.disk_total : "auto"]} ticks={node.disk_total > 0 ? quarters(node.disk_total) : undefined} tickFormatter={axisBytes} {...VALUE_AXIS} />
                <Tooltip {...TOOLTIP} formatter={(v) => bytes(Number(v))} />
                <Area dataKey="disk_used" name="硬盘" stroke="var(--color-chart-2)" fill="var(--color-chart-2)" fillOpacity={0.15} {...RESOURCE_SERIES} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>
        </div>
      )}
    </div>
  )
}
