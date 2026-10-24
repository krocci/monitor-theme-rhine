import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import {
  buildPingPaths, nearestTimeIndex, pingSampleAt, preparePingHistory, selectPingWindow,
  type PingPoint, type PingSeries,
} from "./history.ts"

const point = (id: number, ts: number, latency: number | null, extra = {}): PingPoint => ({
  task_id: id, ts, latency, ...extra,
})
const paths = (probe: PingSeries, from = 0, to = 1_000_000, width = 1_000, smooth = false) =>
  buildPingPaths(probe.samples, from, to, width, (ts) => ts / 1_000, (value) => value, smooth)
const commands = (path: string, command: string) => path.split(command).length - 1

assert.deepEqual(preparePingHistory([]), { rows: [], series: [] })
assert.equal(nearestTimeIndex([], 0), -1)

{
  const history = preparePingHistory([{ id: 7, points: [point(7, 30, 0)] }])
  const probe = history.series[0]
  assert.equal(probe.samples[0].value, 0, "zero millisecond answers remain valid")
  assert.deepEqual(probe.samples[0].band, [0, 0])
  assert.equal(paths(probe).line, "", "one answer does not pretend to form a line")
  assert.equal(commands(paths(probe).dots, "M"), 1, "an isolated answer remains visible")
  assert.equal(pingSampleAt(probe, 30_000, 0, 60_000)?.value, 0)
  assert.equal(pingSampleAt(probe, 31_000, 0, 60_000), null, "one sample does not imply a reporting cadence")
}

{
  const history = preparePingHistory([{
    id: 1,
    points: [point(1, 0, 20), point(1, 60, null, { loss: 100 }), point(1, 120, 22)],
  }])
  const probe = history.series[0]
  assert.deepEqual(probe.samples.map((sample) => sample.value), [20, null, 22])
  assert.equal(probe.samples[1].loss, 100, "measured bucket loss remains unchanged")
  assert.equal(probe.samples[1].band, null, "a timeout creates no latency band")
  assert.equal(probe.samples[2].breakBefore, true)
  assert.equal(paths(probe).line, "", "a timeout never joins the two isolated successes")
  assert.equal(commands(paths(probe).dots, "M"), 2)
  assert.equal(pingSampleAt(probe, 60_000, 0, 120_000)?.value, null, "tooltip returns the timeout, not a nearby successful answer")
}

{
  const history = preparePingHistory([{
    id: 1,
    points: [point(1, 0, null), point(1, 60, null), point(1, 120, null)],
  }])
  assert.equal(history.rows.length, 3, "timeouts remain in the common time window")
  assert.equal(history.series[0].answers, 0)
  assert.deepEqual(paths(history.series[0]), { line: "", band: "", dots: "", vertices: 0 })
  const selected = selectPingWindow(history.series, 0, 120_000, false)
  assert.equal(selected.hasSamples, true)
  assert.equal(selected.hasAnswers, false)
  assert.deepEqual(selected.domain, [0, 1], "all-failed data has a finite axis")
  assert.equal(selectPingWindow(history.series, 180_000, 240_000, false).hasSamples, false)
}

{
  const history = preparePingHistory([
    { id: 1, points: [point(1, 0, 10), point(1, 60, 12), point(1, 120, 14)] },
    { id: 2, points: [point(2, 3, 20), point(2, 63, 21), point(2, 123, 22)] },
  ])
  assert.equal(history.rows.length, 6, "shared Brush retains the union time axis")
  assert.equal(history.series.length, 2, "the number of drawing series is the number of probes")
  assert.equal(commands(paths(history.series[0]).line, "M"), 1, "another probe's timestamps cannot split this probe")
  assert.equal(pingSampleAt(history.series[1], 60_000, 0, 130_000)?.ts, 63_000, "tooltip locates a nearby original timestamp, not a shared row index")
  assert.equal(pingSampleAt(history.series[1], 60_000, 0, 130_000)?.value, 21)
  assert.equal(pingSampleAt(history.series[1], 60_000, 0, 60_000), null, "tooltip cannot read samples outside the zoom range")
  assert.equal(nearestTimeIndex(history.rows, 61_000), 2)
  assert.equal(nearestTimeIndex(history.rows, 999_000, 1, 3), 3)
}

{
  const history = preparePingHistory([
    { id: 1, points: [point(1, 0, 20), point(1, 60, 21), point(1, 120, 22), point(1, 600, 25), point(1, 660, 26)] },
    { id: 2, points: [point(2, 180, 30), point(2, 240, 31), point(2, 300, 32), point(2, 360, 33)] },
  ])
  const probe = history.series[0]
  assert.equal(commands(paths(probe).line, "M"), 2, "reporting gap remains separate even if other probes fill it")
  assert.equal(pingSampleAt(probe, 300_000, 0, 660_000), null, "tooltip never carries an old answer through a missing interval")
  const regular = preparePingHistory([{ id: 3, points: [0, 300, 600, 900].map((ts) => point(3, ts, 40)) }])
  assert.equal(commands(paths(regular.series[0]).line, "M"), 1, "regular slow reporting remains continuous")
  const zoom = selectPingWindow(history.series, 600_000, 660_000, false)
  assert.deepEqual(zoom.series[0].samples.map((sample) => sample.ts), [600_000, 660_000])
  assert.equal(commands(paths(zoom.series[0]).line, "M"), 1)
}

{
  const points = [20, 21, 20, 900, 21, 20, 21].map((latency, i) =>
    point(4, i * 60, latency, { band: [latency - 1, latency + 1], loss: i === 3 ? 15 : 0 }))
  const input = [{ id: 4, points }]
  const before = JSON.stringify(input)
  const history = preparePingHistory(input)
  const probe = history.series[0]
  assert.equal(probe.samples[3].value, 900, "raw spikes are retained")
  assert.equal(probe.samples[3].filtered, 21, "explicit smoothing keeps the existing Hampel result")
  assert.equal(probe.samples[3].loss, 15, "smoothing does not rewrite measured loss")
  for (const sample of probe.samples) {
    assert.ok(sample.filteredBand![0] <= sample.filtered! && sample.filtered! <= sample.filteredBand![1])
  }
  assert.ok(paths(probe).line.includes(",900"))
  assert.ok(!paths(probe, 0, 1_000_000, 1_000, true).line.includes(",900"))
  assert.ok(selectPingWindow(history.series, 0, 360_000, false).domain[1] > 900)
  assert.ok(selectPingWindow(history.series, 0, 360_000, true).domain[1] < 100)
  assert.equal(JSON.stringify(input), before, "input samples are never mutated")
}

{
  const points = [point(8, 120, 11), point(8, 0, 10), point(8, 60, null)]
  const history = preparePingHistory([{ id: 8, points }])
  assert.deepEqual(history.rows.map((row) => row.ts), [0, 60_000, 120_000])
  assert.equal(commands(paths(history.series[0]).dots, "M"), 2)
  assert.equal(points[0].ts, 120)
}

{
  const history = preparePingHistory([{
    id: 9,
    points: Array.from({ length: 2_000 }, (_, i) => point(9, i * 60, i % 2 ? null : 10)),
  }])
  assert.equal(history.series.length, 1, "a thousand losses do not allocate a thousand graphical series")
  const result = paths(history.series[0])
  assert.equal(result.line, "")
  assert.equal(commands(result.dots, "M"), 1_000, "all isolated successes remain visible in one SVG path")
}

{
  const points = Array.from({ length: 10_000 }, (_, i) => point(1, i, i === 4_123 ? 900 : i === 4_456 ? 0 : 25,
    { band: [i === 6_789 ? 1 : 20, i === 7_890 ? 1_100 : 30] }))
  const history = preparePingHistory([{ id: 1, points }])
  const result = paths(history.series[0], 0, 9_999_000, 100)
  assert.ok(result.vertices <= 6 * 101, "dense continuous series have a pixel-derived vertex budget")
  assert.ok(result.line.includes("4123,900"), "thinning preserves narrow spikes")
  assert.ok(result.line.includes("4456,0"), "thinning preserves narrow troughs")
  assert.ok(result.band.includes("6789,1"), "thinning preserves the low band extreme")
  assert.ok(result.band.includes("7890,1100"), "thinning preserves the high band extreme")
  const zoom = selectPingWindow(history.series, 4_000_000, 4_500_000, false)
  const detailed = paths(zoom.series[0], 4_000_000, 4_500_000, 1_000)
  assert.equal(detailed.vertices, 501, "zooming regenerates from the original samples rather than the overview vertices")
  assert.equal(pingSampleAt(history.series[0], 4_124_000, 0, 9_999_000)?.value, 25, "tooltip reads raw points removed from the overview")
}

{
  const { denseSyntheticHistory } = await import(new URL("../../tests/fixtures.mjs", import.meta.url).href)
  const fixture = denseSyntheticHistory(101, new URLSearchParams("hours=24&series=ping"), 1792800000) as {
    ping: PingPoint[]; probes: Record<string, string>
  }
  const probes = Object.keys(fixture.probes).map(Number).map((id) => ({ id, points: fixture.ping.filter((p) => p.task_id === id) }))
  const started = performance.now()
  const history = preparePingHistory(probes)
  const from = history.rows[0].ts
  const to = history.rows.at(-1)!.ts
  const window = selectPingWindow(history.series, from, to, false)
  const rendered = window.series.map((probe) => paths(probe, from, to, 1_200))
  assert.equal(fixture.ping.length, 24_780)
  assert.equal(history.series.length, 7)
  assert.equal(rendered.length * 3, 21, "the day chart needs at most three SVG paths per probe, not thousands of Recharts series")
  assert.ok(rendered.every((result) => result.vertices < 3_600))
  assert.ok(history.series.every((probe) => probe.samples.some((sample) => sample.value !== null && sample.value > 600)))
  assert.ok(history.series.every((probe) => probe.samples.some((sample) => sample.value === null)))
  console.log(`dense fixture: ${fixture.ping.length} samples, 7 probes, <=21 paths, ${rendered.reduce((n, p) => n + p.vertices, 0)} vertices, ${Math.round(performance.now() - started)} ms preprocessing + geometry`)
}

console.log("history continuity, thinning, tooltip and dense rendering tests passed")
