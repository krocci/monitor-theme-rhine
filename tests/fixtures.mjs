// Synthetic fixtures only. No host names, addresses or samples are copied from production.
export const NORMAL_TITLE = "\u83b1\u8335\u89c2\u6d4b\u7ad9 \u00b7 \u672c\u5730\u6f14\u793a"
export const TITLES = Object.freeze({
  normal: NORMAL_TITLE,
  empty: "",
  long: `${NORMAL_TITLE} / ${"OBSERVATION ARCHIVE ".repeat(12)}`,
  malicious: '<img src=x onerror="globalThis.__RHINE_TITLE_XSS__=true"> & <script>__RHINE_TITLE_XSS__=true</script>',
})

const GiB = 1024 ** 3
const MiB = 1024 ** 2

function metrics(index, now) {
  const phase = now / 9 + index * 1.7
  const memTotal = [4, 8, 2, 4, 16, 8][index] * GiB
  const diskTotal = [40, 80, 25, 40, 160, 80][index] * GiB
  return {
    uptime: 86400 * (index + 2) + now % 86400,
    cpu: Math.round((18 + index * 7 + Math.sin(phase) * 9) * 10) / 10,
    load: [0.42 + index * 0.11, 0.39 + index * 0.1, 0.34 + index * 0.1],
    mem_total: memTotal,
    mem_used: Math.round(memTotal * (0.27 + index * 0.07)),
    swap_total: index % 2 ? GiB : 0,
    swap_used: index % 2 ? 42 * MiB : 0,
    disk_total: diskTotal,
    disk_used: Math.round(diskTotal * (0.19 + index * 0.08)),
    net_rx: Math.round((1.2 + index * 0.4 + Math.sin(phase) * 0.3) * MiB),
    net_tx: Math.round((0.3 + index * 0.13 + Math.cos(phase) * 0.09) * MiB),
    total_rx: (100 + index * 80) * GiB,
    total_tx: (50 + index * 30) * GiB,
    month_rx: (20 + index * 5) * GiB,
    month_tx: (5 + index * 2) * GiB,
    tcp: 35 + index * 11,
    udp: 4 + index,
    procs: 83 + index * 9,
  }
}

export function syntheticNodes(now = Math.floor(Date.now() / 1000)) {
  const names = [
    "Aster / Laboratory 01",
    "Juniper / Laboratory 02",
    "Cascade / Offline specimen",
    "Quartz / Awaiting first report",
    "Cedar / Ungrouped specimen",
    "Long-name specimen - OBSERVATION-ARCHIVE-EDGE-ALPHA-0123456789",
  ]
  const groups = ["CORE", "CORE", "EDGE", "NEW", undefined, "EDGE"]
  return names.map((name, index) => {
    const m = metrics(index, now)
    const lastSeen = index === 2 ? now - 3661 : index === 3 ? 0 : now - 1
    return {
      id: 101 + index,
      name,
      sort: index,
      public: false,
      online: index !== 2,
      country: ["DE", "CA", "NZ", "", "", "FI"][index],
      ...(groups[index] === undefined ? {} : { group: groups[index] }),
      last_seen: lastSeen,
      last_seen_ago: lastSeen ? now - lastSeen : null,
      metrics: index === 2 || index === 3 ? null : m,
      os: index === 3 ? "" : "Synthetic Linux 1.0",
      kernel: index === 3 ? "" : "6.0.0-demo",
      arch: index === 3 ? "" : index === 4 ? "aarch64" : "x86_64",
      virt: index === 3 ? "" : "kvm",
      cpu_name: index === 3 ? "" : "Synthetic reference processor",
      cpu_cores: index === 3 ? 0 : index === 4 ? 8 : 2,
      mem_total: index === 3 ? 0 : m.mem_total,
      swap_total: index === 3 ? 0 : m.swap_total,
      disk_total: index === 3 ? 0 : m.disk_total,
      agent_version: index === 3 ? "" : "1.2.2-demo",
      public_remark: "Synthetic local fixture; not a live server.",
      price: 0,
      currency: "USD",
      billing_cycle: "monthly",
      expires_at: null,
      expires_in: null,
      traffic_limit: 0,
      traffic_mode: "sum",
      traffic_reset_day: 1,
      total_rx: m.total_rx,
      total_tx: m.total_tx,
      month_rx: m.month_rx,
      month_tx: m.month_tx,
      month_used: m.month_rx + m.month_tx,
      month_start: "2026-10-01",
      day_rx: (1 + index) * GiB,
      day_tx: (0.25 + index * 0.1) * GiB,
    }
  })
}

export function syntheticHistory(id, params = new URLSearchParams(), now = Math.floor(Date.now() / 1000)) {
  const hours = Math.max(1, Math.min(7 * 24, Number(params.get("hours")) || 6))
  const count = Math.min(120, Math.max(60, Number(params.get("points")) || 120))
  const step = Math.max(60, Math.ceil(hours * 3600 / count / 60) * 60)
  const end = Math.floor(now / step) * step
  const series = params.get("series")
  const wantsMetrics = !series || series === "metrics"
  const wantsPing = !series || series === "ping"
  const probes = id === 106 ? {} : {
    201: "Reference / nominal",
    202: "Reference / intermittent timeout",
    203: "Reference / all attempts failed",
    204: "Reference / no samples yet",
  }
  const m = metrics(Math.max(0, id - 101), now)
  const resourceRows = []
  const pingRows = []
  if (id !== 104) {
    for (let index = 0; index < count; index++) {
      const ts = end - (count - index - 1) * step
      // Missing buckets are intentional; the chart must not bridge this gap as measured data.
      if (index < 36 || index > 41) {
        const rx = Math.max(0, Math.round(m.net_rx * (0.85 + Math.sin(index / 4) * 0.35)))
        const tx = Math.max(0, Math.round(m.net_tx * (0.85 + Math.cos(index / 5) * 0.35)))
        resourceRows.push({
          ts,
          cpu: Math.round((20 + (id - 101) * 6 + Math.sin(index / 6) * 12) * 10) / 10,
          mem_used: Math.round(m.mem_used * (0.92 + Math.sin(index / 9) * 0.04)),
          disk_used: Math.round(m.disk_used * (0.98 + index / count * 0.02)),
          net_rx: rx,
          net_tx: tx,
          net_rx_max: Math.round(rx * 1.6),
          net_tx_max: Math.round(tx * 1.4),
          minutes: step / 60,
        })
      }
      if (id !== 106) {
        const nominal = Math.round((18 + Math.sin(index / 5) * 4) * 10) / 10
        const intermittent = index % 7 === 0 ? null : Math.round((46 + Math.sin(index / 3) * 11) * 10) / 10
        pingRows.push(
          { task_id: 201, ts, latency: nominal, band: [nominal - 2, nominal + 4] },
          { task_id: 202, ts, latency: intermittent, ...(intermittent === null ? { loss: 100 } : { band: [intermittent - 3, intermittent + 6] }) },
          { task_id: 203, ts, latency: null, loss: 100 },
        )
      }
    }
  }
  return {
    metrics: wantsMetrics ? resourceRows : [],
    ping: wantsPing ? pingRows : [],
    probes: wantsPing ? probes : {},
    loss: wantsPing && id !== 104 && id !== 106 ? {
      202: Math.ceil(count / 7) / count * 100,
      203: 100,
    } : {},
    step,
  }
}

/**
 * Dense latency only: seven independent probes, staggered clocks, measured
 * spikes, timeouts and absent intervals. Up to one day, keep raw attempts even
 * when the requested point budget is smaller, as the native history API does.
 */
export function denseSyntheticHistory(id, params = new URLSearchParams(), now = Math.floor(Date.now() / 1000)) {
  const baseline = syntheticHistory(id, params, now)
  if (id === 104 || id === 106 || params.get("series") === "metrics") return baseline
  const hours = Math.max(1, Math.min(7 * 24, Number(params.get("hours")) || 6))
  const step = Math.max(24, Math.ceil(hours * 3600 / 3600))
  const count = Math.floor(hours * 3600 / step)
  const end = Math.floor(now / step) * step - step
  const probes = {}
  const ping = []
  const loss = {}
  const thresholds = [10, 12, 16, 11, 14, 13, 15]
  for (let probe = 0; probe < 7; probe++) {
    const taskId = 301 + probe
    probes[taskId] = `Synthetic route ${String(probe + 1).padStart(2, "0")}`
    let attempts = 0
    let failed = 0
    for (let index = 0; index < count; index++) {
      // A missing interval is not a measured timeout or a zero-latency sample.
      const gapPosition = (index + probe * 19) % 900
      if (gapPosition >= 420 && gapPosition < 435) continue
      const ts = end - (count - index - 1) * step + probe * 3
      const timeout = (index * 73 + probe * 149) % 100 < thresholds[probe]
      const spike = index % 97 === 0 ? 620 + probe * 29 : index % 251 === 0 ? 280 : 0
      const latency = timeout ? null : Math.round((28 + probe * 17
        + Math.sin(index / 17 + probe) * 11 + Math.cos(index / 5) * 4 + spike) * 10) / 10
      ping.push({
        task_id: taskId,
        ts,
        latency,
        ...(timeout ? { loss: 100 } : hours > 24 ? { band: [Math.max(0, latency - 5), latency + 8] } : {}),
      })
      attempts++
      if (timeout) failed++
    }
    loss[taskId] = failed / attempts * 100
  }
  ping.sort((a, b) => a.ts - b.ts || a.task_id - b.task_id)
  return { ...baseline, ping, probes, loss, step }
}
