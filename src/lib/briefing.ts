import { finiteMetric } from "./rhine.ts"

export type BriefPoint = {
  ts: number
  cpu: number | null
  mem_used: number | null
  net_tx: number | null
  net_rx: number | null
}
export type BriefHistory = { rows: BriefPoint[]; step: number; from: number; to: number }
export const BRIEF_TTL = 60_000

export function readBriefHistory(input: unknown, now: number): BriefHistory {
  if (!input || typeof input !== "object" || !("metrics" in input) || !Array.isArray(input.metrics)) {
    throw new Error("历史接口未返回可识别的资源数据")
  }
  const to = Math.floor(now / 1000)
  const from = to - 3600
  const unique = new Map<number, BriefPoint>()
  for (const item of input.metrics) {
    if (!item || typeof item !== "object") continue
    const ts = finiteMetric(item.ts)
    if (ts === null || ts < from || ts > to) continue
    unique.set(ts, { ts, cpu: finiteMetric(item.cpu), mem_used: finiteMetric(item.mem_used),
      net_tx: finiteMetric(item.net_tx), net_rx: finiteMetric(item.net_rx) })
  }
  const rows = [...unique.values()].sort((a, b) => a.ts - b.ts)
  const gaps = rows.slice(1).map((row, i) => row.ts - rows[i].ts).sort((a, b) => a - b)
  const supplied = "step" in input ? finiteMetric(input.step) : null
  return { rows, step: supplied && supplied > 0 ? supplied : gaps[(gaps.length - 1) >> 1] ?? 0, from, to }
}

export function briefTrace(history: BriefHistory, key: Exclude<keyof BriefPoint, "ts">, top: number) {
  const segments: { x: number; y: number }[][] = []
  let segment: { x: number; y: number }[] = []
  let previous: number | null = null
  for (const row of history.rows) {
    const value = row[key]
    if (value === null || (previous !== null && history.step > 0 && row.ts - previous > history.step * 2)) {
      if (segment.length) segments.push(segment)
      segment = []
    }
    if (value !== null) segment.push({
      x: 2 + ((row.ts - history.from) / Math.max(1, history.to - history.from)) * 296,
      y: 62 - (value / Math.max(1, top)) * 58,
    })
    previous = row.ts
  }
  if (segment.length) segments.push(segment)
  return {
    path: segments.filter((part) => part.length > 1).map((part) =>
      part.map(({ x, y }, i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("")).join(""),
    dots: segments.filter((part) => part.length === 1).map((part) => part[0]),
  }
}

/** Scoped to one mounted briefing; no persistent or cross-session snapshots. */
export function createBriefCache(limit = 12) {
  const entries = new Map<number, { data: BriefHistory; loadedAt: number }>()
  return {
    get(id: number, now: number) {
      const value = entries.get(id)
      return value && now - value.loadedAt < BRIEF_TTL ? value : undefined
    },
    set(id: number, data: BriefHistory, loadedAt: number) {
      entries.delete(id)
      entries.set(id, { data, loadedAt })
      while (entries.size > limit) entries.delete(entries.keys().next().value!)
    },
    clear() { entries.clear() },
  }
}
