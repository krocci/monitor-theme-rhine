import type { CSSProperties } from "react"
import type { Node } from "@/lib/api"
import { archiveCardPose } from "@/lib/carousel"
import { pair } from "@/lib/format"
import { displayPercent, finiteMetric, nodeStatus, percentLabel } from "@/lib/rhine"

const SHANGHAI = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

export function stamp(ms: number, full = false): string {
  if (!Number.isFinite(ms) || ms <= 0 || Number.isNaN(new Date(ms).getTime())) return "--"
  const parts = Object.fromEntries(SHANGHAI.formatToParts(ms).map(({ type, value }) => [type, value]))
  const time = `${parts.hour}:${parts.minute}:${parts.second}`
  return full ? `${parts.year}-${parts.month}-${parts.day} ${time}` : time
}

const STATUS = { online: "在线", offline: "离线", unknown: "未上报" }
const serial = (id: number) => `N-${String(id).padStart(3, "0")}`

export function NodeStatus({ node, stale = false }: { node: Node; stale?: boolean }) {
  const status = nodeStatus(node)
  return (
    <span
      className={`status-tag status-${status}${stale ? " is-stale" : ""}`}
      aria-label={`节点上报状态：${STATUS[status]}${stale ? "，来自上次快照" : ""}`}
    >
      <span className="status-dot" aria-hidden="true" />
      <span>{STATUS[status]}</span>
      {stale && <small className="status-source">上次快照</small>}
    </span>
  )
}

export function SnapshotNote({ node, stale, receivedAt }: {
  node: Node
  stale: boolean
  receivedAt?: number | null
}) {
  const status = nodeStatus(node)
  if (stale) {
    return (
      <p className="snapshot-note is-stale">
        上次快照 {receivedAt ? stamp(receivedAt, true) : "--"} (UTC+8)
      </p>
    )
  }
  return (
    <p className={`snapshot-note${status === "offline" ? " is-offline" : ""}`}>
      {status === "unknown"
        ? "尚未收到有效上报"
        : `${status === "offline" ? "节点离线，指标为最后已知值 · " : ""}最近上报 ${stamp(node.last_seen * 1000, true)} (UTC+8)`}
    </p>
  )
}

export function ArchiveStack({ nodes, selectedId, onSelect, wheelOffset = 0, wheelActive = false }: {
  nodes: Node[]
  selectedId: number | null
  onSelect: (id: number) => void
  wheelOffset?: number
  wheelActive?: boolean
}) {
  const selected = Math.max(0, nodes.findIndex((node) => node.id === selectedId))
  const visible = nodes.map((node, index) => ({
    node, pose: archiveCardPose(index, nodes.length, selected, wheelOffset),
  })).filter(({ pose }) => pose.opacity > 0)
  return (
    <div
      className={`archive-stage${wheelActive ? " is-wheel-moving" : ""}`}
      role="group"
      aria-label="节点档案选择"
      data-wheel-offset={wheelOffset}
      data-wheel-active={wheelActive}
    >
      <div className="archive-caption" aria-hidden="true">
        <span>NODE ARCHIVE / 节点档案</span>
        <span>{nodes.length} RECORDS</span>
      </div>
      <div className="archive-sheets">
        {visible.map(({ node, pose }) => {
          const selected = node.id === selectedId
          return (
            <button
              type="button"
              key={node.id}
              className={`archive-sheet${selected ? " is-selected" : ""}`}
              style={{
                "--sheet-index": pose.slot,
                "--sheet-focus": pose.focus,
                "--sheet-depth": pose.depth,
                opacity: pose.opacity,
                zIndex: 1 + Math.round((1 - pose.depth) * 10 + pose.focus * 10),
              } as CSSProperties}
              onClick={() => onSelect(node.id)}
              aria-pressed={selected}
              aria-label={`${serial(node.id)} ${node.name}，${STATUS[nodeStatus(node)]}${selected ? "，当前选中" : ""}`}
              title={node.name}
            >
              <span className="sheet-topline">
                <span>OBSERVATION FILE</span>
                <span className="sheet-marker" aria-hidden="true" />
              </span>
              <span className="sheet-id">{serial(node.id)}</span>
              <span className="sheet-rule" aria-hidden="true" />
              <span className="sheet-name">{node.name}</span>
              <span className="sheet-group">{node.group || "未分组"}</span>
              <span className={`sheet-status status-${nodeStatus(node)}`}>
                <span className="status-dot" aria-hidden="true" />{STATUS[nodeStatus(node)]}
              </span>
              <span className="sheet-footer" aria-hidden="true">MONITOR / NODE RECORD</span>
            </button>
          )
        })}
        {visible.length === 0 && <p className="archive-empty">暂无可展示的节点。</p>}
      </div>
    </div>
  )
}

function InstrumentRing({ size, value, label, caption }: {
  size: "large" | "small"
  value: number | null
  label: string
  caption: string
}) {
  const box = size === "large" ? 260 : 180
  const radius = size === "large" ? 102 : 68
  const center = box / 2
  const drawing = value === null ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div
      className={`instrument-ring ${size}${value === null ? " is-unknown" : ""}`}
      role="img"
      aria-label={`${label}使用率：${value === null ? "未知" : percentLabel(value)}`}
    >
      <svg viewBox={`0 0 ${box} ${box}`} aria-hidden="true">
        <circle className="ring-guide" cx={center} cy={center} r={radius + 14} fill="none" />
        <circle className="ring-track" cx={center} cy={center} r={radius} fill="none" />
        <circle
          className="ring-value"
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          pathLength={100}
          strokeDasharray={`${drawing} 100`}
          strokeLinecap="butt"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <div className="ring-caption" aria-hidden="true">
        <span className="ring-label">{label}</span>
        <strong>{percentLabel(value)}</strong>
        <small>{caption}</small>
      </div>
    </div>
  )
}

function usage(used: unknown, total: unknown): string {
  const value = finiteMetric(used)
  const capacity = finiteMetric(total)
  return value === null || capacity === null || capacity <= 0 ? "--" : pair(value, capacity)
}

export function InstrumentPlate({ node, compact = false }: { node: Node; compact?: boolean }) {
  const cpu = displayPercent(node, "cpu")
  const memory = displayPercent(node, "mem")
  const disk = displayPercent(node, "disk")
  return (
    <section className={`instrument-plate${compact ? " is-compact" : ""}`} aria-label="节点资源仪表">
      <div className="plate-head">
        <span className="plate-serial">{serial(node.id)}</span>
        <span className="plate-kind">RESOURCE OBSERVATION</span>
      </div>
      <div className="plate-rings">
        <InstrumentRing size="large" value={cpu} label="CPU" caption="处理器使用率" />
        <InstrumentRing size="small" value={memory} label="MEMORY" caption="内存使用率" />
      </div>
      <div className="plate-memory">
        <span>MEMORY / 已用与总量</span>
        <strong>{usage(node.metrics?.mem_used, node.metrics?.mem_total)}</strong>
      </div>
      <div className={`plate-disk${disk === null ? " is-unknown" : ""}`}>
        <div className="plate-disk-head">
          <span>DISK / 存储</span>
          <strong>{percentLabel(disk)}</strong>
        </div>
        <div className="plate-disk-track" aria-hidden="true">
          {disk !== null && <span className="plate-disk-value" style={{ width: `${Math.max(0, Math.min(100, disk))}%` }} />}
        </div>
        <p className="plate-disk-caption">{usage(node.metrics?.disk_used, node.metrics?.disk_total)}</p>
      </div>
      <div className="plate-caption" aria-hidden="true">
        <span>READ ONLY / 只读观测</span>
        <span>CPU · MEMORY · DISK</span>
      </div>
    </section>
  )
}
