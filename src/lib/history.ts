import { despike, withGaps } from "./format.ts"

export type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}

type ProbeInput = { id: number; points: PingPoint[] }
export type PingSample = {
  ts: number
  value: number | null
  filtered: number | null
  band: [number, number] | null
  filteredBand: [number, number] | null
  loss: number
  breakBefore: boolean
}
export type PingSeries = {
  id: number
  samples: PingSample[]
  spacing: number
  answers: number
}
export type PingHistory = { rows: { ts: number }[]; series: PingSeries[] }
export type PingWindow = {
  series: PingSeries[]
  domain: [number, number]
  hasSamples: boolean
  hasAnswers: boolean
}
export type PingPaths = { line: string; band: string; dots: string; vertices: number }

function spacingOf(points: { ts: number }[]): number {
  const gaps = points.slice(1).map((point, index) => point.ts - points[index].ts).filter((gap) => gap > 0)
  gaps.sort((a, b) => a - b)
  return gaps[(gaps.length - 1) >> 1] ?? 0
}

function despikeWindow(points: { ts: number }[]): number {
  let step = Infinity
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].ts - points[i - 1].ts
    if (gap > 0) step = Math.min(step, gap)
  }
  return Math.min(15, Math.max(3, Math.round(420 / step) | 1))
}

/**
 * Keep each probe's own clock and break markers. A timeout adds data, not another
 * chart series: rendering a day of losses must not multiply every row by every
 * successful run. The time union is used only by the shared range selector.
 */
export function preparePingHistory(probes: ProbeInput[]): PingHistory {
  const times = new Set<number>()
  const series = probes.map((probe) => {
    const points = [...probe.points].sort((a, b) => a.ts - b.ts)
    const windowSize = despikeWindow(points)
    const filtered = despike(points.map((point) => point.latency), windowSize)
    const low = despike(points.map((point) => point.latency === null ? null : point.band?.[0] ?? point.latency), windowSize)
    const high = despike(points.map((point) => point.latency === null ? null : point.band?.[1] ?? point.latency), windowSize)
    const samples: PingSample[] = []
    let breakBefore = true
    let index = 0
    let answers = 0
    for (const point of withGaps(points)) {
      if (!("latency" in point)) {
        breakBefore = true
        continue
      }
      const i = index++
      const value = point.latency
      const band: [number, number] | null = value === null ? null : point.band ?? [value, value]
      const filteredBand: [number, number] | null = low[i] === null || high[i] === null
        ? null
        : [Math.min(low[i], high[i], filtered[i] ?? low[i]), Math.max(low[i], high[i], filtered[i] ?? high[i])]
      const ts = point.ts * 1_000
      samples.push({ ts, value, filtered: filtered[i], band, filteredBand, loss: point.loss ?? 0, breakBefore })
      times.add(ts)
      if (value !== null) answers++
      breakBefore = value === null
    }
    return { id: probe.id, samples, spacing: spacingOf(points) * 1_000, answers }
  })
  return { rows: [...times].sort((a, b) => a - b).map((ts) => ({ ts })), series }
}

function lowerBound<T extends { ts: number }>(rows: T[], ts: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle].ts < ts) low = middle + 1
    else high = middle
  }
  return low
}

export function nearestTimeIndex(rows: { ts: number }[], ts: number, from = 0, to = rows.length - 1): number {
  if (rows.length === 0 || to < from) return -1
  const next = Math.max(from, Math.min(to, lowerBound(rows, ts)))
  const previous = Math.max(from, next - 1)
  return Math.abs(rows[previous].ts - ts) <= Math.abs(rows[next].ts - ts) ? previous : next
}

/** Look up original samples, never an interpolated or thinned chart vertex. */
export function pingSampleAt(series: PingSeries, ts: number, from: number, to: number): PingSample | null {
  const first = lowerBound(series.samples, from)
  let last = lowerBound(series.samples, to)
  if (series.samples[last]?.ts !== to) last--
  const index = nearestTimeIndex(series.samples, ts, first, last)
  const sample = series.samples[index]
  if (!sample || sample.ts < from || sample.ts > to) return null
  // A nearby probe may report a few seconds later. Do not carry an old answer
  // across its missing interval; the tooltip also displays this sample's clock.
  return Math.abs(sample.ts - ts) <= series.spacing / 2 ? sample : null
}

export function selectPingWindow(series: PingSeries[], from: number, to: number, smooth: boolean): PingWindow {
  let low = Infinity
  let high = -Infinity
  let hasSamples = false
  let hasAnswers = false
  const selected = series.map((probe) => {
    const first = lowerBound(probe.samples, from)
    let end = lowerBound(probe.samples, to)
    if (probe.samples[end]?.ts === to) end++
    const samples = probe.samples.slice(first, end)
    hasSamples ||= samples.length > 0
    for (const sample of samples) {
      const value = smooth ? sample.filtered : sample.value
      const band = smooth ? sample.filteredBand : sample.band
      if (value === null) continue
      hasAnswers = true
      low = Math.min(low, value, band?.[0] ?? value)
      high = Math.max(high, value, band?.[1] ?? value)
    }
    return { ...probe, samples }
  })
  const padding = Math.max(2, (high - low) * 0.15)
  return {
    series: selected,
    domain: hasAnswers ? [Math.max(0, Math.floor(low - padding)), Math.ceil(high + padding)] : [0, 1],
    hasSamples,
    hasAnswers,
  }
}

function displayedValue(sample: PingSample, smooth: boolean): number | null {
  return smooth ? sample.filtered : sample.value
}

function displayedBand(sample: PingSample, smooth: boolean): [number, number] | null {
  return smooth ? sample.filteredBand : sample.band
}

/**
 * Retain the endpoints and extrema in each horizontal pixel of a continuous
 * run. Every break survives, while unresolvable intermediate points do not add
 * SVG work. Zooming calls this again against the original samples.
 */
function thinRun(run: PingSample[], from: number, span: number, width: number, smooth: boolean): PingSample[] {
  if (run.length < 8) return run
  const output: PingSample[] = []
  let bucket = -Infinity
  let first = 0
  let min = 0
  let max = 0
  let bandMin = 0
  let bandMax = 0
  const flush = (last: number) => {
    for (const index of [...new Set([first, min, max, bandMin, bandMax, last])].sort((a, b) => a - b)) {
      output.push(run[index])
    }
  }
  for (let i = 0; i < run.length; i++) {
    const nextBucket = Math.floor((run[i].ts - from) / span * width)
    if (nextBucket !== bucket) {
      if (i > 0) flush(i - 1)
      bucket = nextBucket
      first = min = max = bandMin = bandMax = i
      continue
    }
    if (displayedValue(run[i], smooth)! < displayedValue(run[min], smooth)!) min = i
    if (displayedValue(run[i], smooth)! > displayedValue(run[max], smooth)!) max = i
    if (displayedBand(run[i], smooth)![0] < displayedBand(run[bandMin], smooth)![0]) bandMin = i
    if (displayedBand(run[i], smooth)![1] > displayedBand(run[bandMax], smooth)![1]) bandMax = i
  }
  flush(run.length - 1)
  return output
}

const coordinate = (value: number) => String(Math.round(value * 100) / 100)

/** Three SVG paths per probe, regardless of how many losses split its line. */
export function buildPingPaths(
  samples: PingSample[],
  from: number,
  to: number,
  width: number,
  x: (ts: number) => number,
  y: (value: number) => number,
  smooth: boolean,
): PingPaths {
  const line: string[] = []
  const band: string[] = []
  const dots: string[] = []
  let run: PingSample[] = []
  let vertices = 0
  const flush = () => {
    if (run.length === 0) return
    const points = thinRun(run, from, Math.max(1, to - from), Math.max(1, width), smooth)
    vertices += points.length
    const positions = points.map((point) => {
      const bounds = displayedBand(point, smooth)!
      return {
        x: coordinate(x(point.ts)),
        y: coordinate(y(displayedValue(point, smooth)!)),
        low: coordinate(y(bounds[0])),
        high: coordinate(y(bounds[1])),
      }
    })
    if (positions.length === 1) {
      const point = positions[0]
      dots.push(`M${point.x},${point.y}m-2,0a2,2 0 1,0 4,0a2,2 0 1,0 -4,0`)
    } else {
      line.push(positions.map((point, i) => `${i === 0 ? "M" : "L"}${point.x},${point.y}`).join(""))
    }
    if (points.some((point) => {
      const bounds = displayedBand(point, smooth)!
      return bounds[0] !== bounds[1]
    })) {
      band.push(
        positions.map((point, i) => `${i === 0 ? "M" : "L"}${point.x},${point.high}`).join("")
        + positions.toReversed().map((point) => `L${point.x},${point.low}`).join("") + "Z",
      )
    }
    run = []
  }
  for (const sample of samples) {
    if (sample.breakBefore || displayedValue(sample, smooth) === null) flush()
    if (displayedValue(sample, smooth) !== null) run.push(sample)
  }
  flush()
  return { line: line.join(""), band: band.join(""), dots: dots.join(""), vertices }
}
