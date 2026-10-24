import { performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { denseSyntheticHistory } from "../tests/fixtures.mjs"

const moduleUrl = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href
  : new URL("../src/lib/history.ts", import.meta.url).href
const { preparePingHistory, selectPingWindow, buildPingPaths } = await import(moduleUrl)
if (typeof preparePingHistory !== "function") throw new Error("History module does not export preparePingHistory")

const fixture = denseSyntheticHistory(101, new URLSearchParams("hours=24&series=ping"), 1792800000)
const probes = Object.keys(fixture.probes).map(Number).map((id) => ({
  id,
  points: fixture.ping.filter((point) => point.task_id === id),
}))
const durations = []
let prepared
for (let run = 0; run < 5; run++) {
  const start = performance.now()
  prepared = preparePingHistory(probes)
  durations.push(performance.now() - start)
}
durations.sort((a, b) => a - b)
let rendering = null
if (selectPingWindow && buildPingPaths) {
  const from = prepared.rows[0].ts
  const to = prepared.rows.at(-1).ts
  const geometryDurations = []
  let geometries
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    const window = selectPingWindow(prepared.series, from, to, false)
    geometries = window.series.map((probe) => buildPingPaths(
      probe.samples, from, to, 1_200, (ts) => (ts - from) / (to - from) * 1_200,
      (value) => 240 - value / window.domain[1] * 240, false,
    ))
    geometryDurations.push(performance.now() - start)
  }
  geometryDurations.sort((a, b) => a - b)
  rendering = {
    geometryMedianMs: Number(geometryDurations[2].toFixed(3)),
    svgPathLimit: geometries.length * 3,
    vertices: geometries.reduce((sum, paths) => sum + paths.vertices, 0),
    width: 1_200,
  }
}
console.log(JSON.stringify({
  fixture: "synthetic-seven-probe-day",
  clock: 1792800000,
  inputSamples: fixture.ping.length,
  probeCount: probes.length,
  preprocessingMedianMs: Number(durations[2].toFixed(3)),
  preprocessingMinMs: Number(durations[0].toFixed(3)),
  outputKeys: Object.keys(prepared),
  rows: prepared.rows?.length ?? null,
  segments: prepared.segments?.length ?? null,
  drawingSeries: prepared.series?.length ?? null,
  rendering,
  note: "Node preprocessing and SVG geometry only; browser interaction must be measured separately.",
}, null, 2))
