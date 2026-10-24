import type { Node } from "./api"

export type NodeStatus = "online" | "offline" | "unknown"

/** Unknown samples stay unknown; do not coerce null, strings or NaN to zero. */
export function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

export function nodeStatus(node: Pick<Node, "online" | "last_seen" | "last_seen_ago">): NodeStatus {
  if (!finiteMetric(node.last_seen) || node.last_seen_ago === null) return "unknown"
  return node.online === true ? "online" : node.online === false ? "offline" : "unknown"
}

/** Keep real figures above 100%; only the drawing of a gauge may be capped. */
export function displayPercent(node: Pick<Node, "metrics">, metric: "cpu" | "mem" | "disk"): number | null {
  const metrics = node.metrics
  if (!metrics) return null
  if (metric === "cpu") return finiteMetric(metrics.cpu)
  const used = finiteMetric(metric === "mem" ? metrics.mem_used : metrics.disk_used)
  const total = finiteMetric(metric === "mem" ? metrics.mem_total : metrics.disk_total)
  return used === null || total === null || total === 0 ? null : finiteMetric((used / total) * 100)
}

export function percentLabel(value: number | null, digits = 1): string {
  const valid = finiteMetric(value)
  return valid === null ? "--" : `${valid.toFixed(Math.max(0, Math.min(3, digits)))}%`
}

/** Global navigation must never consume text composition or a control's keys. */
export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return true
  const target = event.target
  if (!(target instanceof Element)) return false
  return Boolean(target.closest(
    "input, textarea, select, button, a, [contenteditable]:not([contenteditable='false']), " +
    "[role='button'], [role='textbox'], [role='combobox'], [role='slider'], [role='tab'], " +
    "[role='grid'], [data-shortcuts='off'], .recharts-wrapper",
  ))
}

/** Preferences contain IDs only, never snapshots, names or authentication data. */
export function parseFavorites(raw: string | null): number[] {
  if (!raw || raw.length > 128_000) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0))].slice(0, 500)
  } catch {
    return []
  }
}
