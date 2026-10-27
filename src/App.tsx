import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Check, Copy, Pause, Play, Search, Settings2, Star, X } from "lucide-react"
import { api, ApiError, groupsOf, useNodes, type Connection } from "./lib/api"
import { bytes, rate, uptime } from "./lib/format"
import { displayPercent, finiteMetric, nodeStatus, parseFavorites, percentLabel, shouldIgnoreShortcut } from "./lib/rhine"
import { ArchiveStack, InstrumentPlate, NodeStatus, SnapshotNote, stamp } from "./components/RhineVisuals"
import { NodeIndex, type IndexFilters } from "./components/NodeIndex"
import { useBriefingCarousel } from "./components/useBriefingCarousel"
import { ROTATION_MS } from "./lib/carousel"
import { BriefingTrends } from "./components/BriefingTrends"
import { useDocumentReveal } from "./components/useDocumentReveal"

const NodeHistory = lazy(() => import("./components/NodeDetail").then((module) => ({ default: module.NodeHistory })))
type Site = { site_name: string; authed: boolean; public_page: boolean; history_days: number }
type DetailTab = "overview" | "resources" | "latency"
const CONNECTION: Record<Connection, string> = {
  connecting: "正在连接", live: "实时更新", polling: "轮询更新",
  stale: "连接中断", paused: "更新已暂停", unauthorized: "需要重新验证",
}
const EMPTY_FILTERS: IndexFilters = { query: "", group: null, status: "all", sort: "default" }
const readLocal = (key: string) => { try { return localStorage.getItem(`rhine.${key}`) } catch { return null } }
const writeLocal = (key: string, value: string) => { try { localStorage.setItem(`rhine.${key}`, value) } catch { /* Preferences are optional. */ } }
const readRoute = () => ({ path: location.pathname, index: new URLSearchParams(location.search).get("index") === "1" })
const metric = (value: unknown, format: (n: number) => string) => {
  const valid = finiteMetric(value)
  return valid === null ? "--" : format(valid)
}

function Entry({ title, children }: { title: string; children?: React.ReactNode }) {
  return <main className="entry-state"><div className="eyebrow">MONITOR / OBSERVATION OS</div><h1>{title}</h1>{children}</main>
}

export default function App() {
  const [site, setSite] = useState<Site | null>(null)
  const [error, setError] = useState("")
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => { if (!site) document.title = "Monitor" }, [site])
  const loadSite = useCallback(async () => {
    const current = ++generation.current
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    try {
      const result = await api<Site>("/me", request.signal, { timeoutMs: 5000, retries: 1 })
      if (!result || typeof result.authed !== "boolean" || typeof result.public_page !== "boolean") throw new Error("站点配置响应不完整")
      if (current !== generation.current) return
      const next = {
        ...result,
        site_name: typeof result.site_name === "string" && result.site_name.trim() ? result.site_name.trim() : "Monitor",
        history_days: Number.isFinite(result.history_days) && result.history_days > 0 ? result.history_days : 1,
      }
      if (!next.authed && !next.public_page) {
        setSite(null)
        location.replace("/admin/")
        return
      }
      setSite(next)
      setError("")
    } catch (reason) {
      if (current !== generation.current || request.signal.aborted) return
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setSite(null)
      setError(reason instanceof Error ? reason.message : "无法读取站点配置")
    }
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Fetching external site configuration is effect work.
    void loadSite()
    const visible = () => { if (!document.hidden) void loadSite() }
    window.addEventListener("focus", visible)
    document.addEventListener("visibilitychange", visible)
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- Invalidate every callback at cleanup time.
      generation.current++
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- Abort the latest in-flight request, not only the first one.
      controller.current?.abort()
      window.removeEventListener("focus", visible)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [loadSite])
  if (!site) return <Entry title={error ? "暂时无法读取站点" : "正在读取观测档案"}>{error && <><p role="alert">{error}</p><button className="solid-button" onClick={() => void loadSite()}>重新读取 <ArrowRight size={18} /></button><a href="/admin/" className="text-link">前往管理登录</a></>}</Entry>
  return <Dashboard key={`${site.authed}:${site.public_page}`} site={site} configError={error} onRevalidate={loadSite} />
}

function Dashboard({ site, configError, onRevalidate }: { site: Site; configError: string; onRevalidate: () => Promise<void> }) {
  const { nodes, connection, receivedAt, closed, error, diagnostics } = useNodes()
  const [route, setRoute] = useState(readRoute)
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const saved = Number(readLocal("selected"))
    return Number.isSafeInteger(saved) && saved > 0 ? saved : null
  })
  const [favorites, setFavorites] = useState(() => parseFavorites(readLocal("favorites")))
  const [group, setGroup] = useState<string | null>(null)
  const [filters, setFilters] = useState<IndexFilters>(EMPTY_FILTERS)
  const [indexEntry, setIndexEntry] = useState(0)
  const [tab, setTab] = useState<DetailTab>("overview")
  const [settings, setSettings] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(() => readLocal("reduceMotion") === "true")
  const [selectionNotice, setSelectionNotice] = useState("")
  const [copyStatus, setCopyStatus] = useState("")
  const [selectionCycle, setSelectionCycle] = useState(0)
  const initialized = useRef(false)
  const settingsRef = useRef<HTMLDialogElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const briefingRef = useRef<HTMLElement>(null)
  const identityRef = useRef<HTMLElement>(null)
  const overviewRef = useRef<HTMLElement>(null)
  const nodeId = Number(/^\/node\/(\d+)\/?$/.exec(route.path)?.[1]) || null
  const selected = nodes?.find((node) => node.id === (nodeId ?? selectedId))
  const stale = connection === "stale" || connection === "paused"
  const groups = groupsOf(nodes ?? [])
  const visibleNodes = (nodes ?? []).filter((node) => group === null || (node.group ?? "") === group)
  const position = visibleNodes.findIndex((node) => node.id === selectedId)
  const detail = Boolean(nodeId)
  useDocumentReveal(identityRef, detail && selected ? String(selected.id) : null, reduceMotion)
  useDocumentReveal(overviewRef, detail && selected && tab === "overview" ? String(selected.id) : null, reduceMotion)

  useEffect(() => {
    const pop = () => setRoute(readRoute())
    window.addEventListener("popstate", pop)
    return () => window.removeEventListener("popstate", pop)
  }, [])
  useEffect(() => {
    if (!nodes?.length || initialized.current) return
    initialized.current = true
    if (selectedId && nodes.some((node) => node.id === selectedId)) return
    // oxlint-disable-next-line react/set-state-in-effect -- Reconcile a persisted ID against the first remote snapshot.
    if (selectedId) setSelectionNotice("上次选中的节点已不可见，已选择当前列表首项。")
    setSelectedId(nodes[0]?.id ?? null)
  }, [nodes, selectedId])
  useEffect(() => {
    const routed = nodeId && nodes?.find((node) => node.id === nodeId)
    // oxlint-disable-next-line react/set-state-in-effect -- Route and remote group changes synchronize the local selection.
    if (routed) setSelectedId(routed.id)
    const current = routed || nodes?.find((node) => node.id === selectedId)
    if (group !== null && current && (current.group ?? "") !== group) setGroup(null)
    else if (group !== null && nodes && !nodes.some((node) => (node.group ?? "") === group)) setGroup(null)
  }, [nodes, nodeId, group, selectedId])
  useEffect(() => { if (selectedId) writeLocal("selected", String(selectedId)) }, [selectedId])
  useEffect(() => { writeLocal("favorites", JSON.stringify(favorites)) }, [favorites])
  useEffect(() => { writeLocal("reduceMotion", String(reduceMotion)) }, [reduceMotion])
  useEffect(() => {
    document.title = detail && selected ? `${selected.name} · ${site.site_name}` : site.site_name
  }, [detail, selected, site.site_name])
  useEffect(() => {
    // A terminated stream may signal a changed session or public-page scope.
    if (closed || connection === "stale") void onRevalidate()
  }, [closed, connection, onRevalidate])
  useEffect(() => {
    const dialog = settingsRef.current
    if (settings && dialog && !dialog.open) dialog.showModal()
    else if (!settings && dialog?.open) dialog.close()
  }, [settings])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Feedback belongs to the externally navigated node only.
    setCopyStatus("")
    if (detail && !route.index) headingRef.current?.focus({ preventScroll: true })
  }, [nodeId, detail, route.index])

  const navigate = useCallback((path: string, replace = false) => {
    if (path === location.pathname + location.search) return
    history[replace ? "replaceState" : "pushState"]({ rhineFrom: location.pathname + location.search }, "", path)
    setRoute(readRoute())
    window.scrollTo({ top: 0, behavior: "instant" })
  }, [])
  const back = useCallback(() => {
    if (typeof history.state?.rhineFrom === "string") history.back()
    else {
      history.replaceState(null, "", "/")
      setRoute(readRoute())
    }
  }, [])
  const openIndex = useCallback((status: IndexFilters["status"] = "all") => {
    setFilters({ ...EMPTY_FILTERS, status })
    setIndexEntry((entry) => entry + 1)
    if (route.index) return
    navigate(`${location.pathname}?index=1`)
  }, [navigate, route.index])
  const closeIndex = useCallback(() => {
    if (typeof history.state?.rhineFrom === "string") history.back()
    else {
      history.replaceState(null, "", location.pathname)
      setRoute(readRoute())
    }
  }, [])
  const openNode = useCallback((id: number) => {
    setSelectedId(id)
    setTab("overview")
    navigate(`/node/${id}`)
  }, [navigate])
  const toggleFavorite = (id: number) => setFavorites((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])
  const chooseNode = useCallback((id: number) => {
    setSelectedId(id)
    setSelectionNotice("")
    setSelectionCycle((value) => value + 1)
  }, [])
  const step = useCallback((direction: number) => {
    if (!visibleNodes.length) return
    setSelectedId((current) => {
      const position = visibleNodes.findIndex((node) => node.id === current)
      const index = position < 0 ? (direction > 0 ? 0 : visibleNodes.length - 1)
        : ((position + direction) % visibleNodes.length + visibleNodes.length) % visibleNodes.length
      return visibleNodes[index].id
    })
    setSelectionNotice("")
    setSelectionCycle((value) => value + 1)
  }, [visibleNodes])
  const collection = `${JSON.stringify(group)}:${visibleNodes.map((node) => node.id).join(",")}`
  const carousel = useBriefingCarousel({
    active: !detail && !route.index && !settings && !closed && Boolean(selected)
      && visibleNodes.length > 1 && (connection === "live" || connection === "polling"),
    reduceMotion,
    region: briefingRef,
    cycle: `${selectedId}:${collection}:${selectionCycle}`,
    collection,
    onStep: step,
  })
  const cancelWheel = carousel.cancelWheel
  const manualStep = useCallback((direction: number) => {
    cancelWheel()
    step(direction)
  }, [cancelWheel, step])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event) || route.index || settings || document.querySelector("dialog[open]")) return
      if (event.key === "/") { event.preventDefault(); openIndex() }
      if (detail) return
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); manualStep(event.key === "ArrowLeft" ? -1 : 1) }
      if (event.key === "Enter" && selected) { event.preventDefault(); openNode(selected.id) }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  }, [detail, openIndex, openNode, route.index, selected, settings, manualStep])

  const selectGroup = (value: string | null) => {
    carousel.cancelWheel()
    setGroup(value)
    setSelectionCycle((cycle) => cycle + 1)
    const next = (nodes ?? []).filter((node) => value === null || (node.group ?? "") === value)
    if (!next.some((node) => node.id === selectedId)) {
      if (next[0]) chooseNode(next[0].id)
      else setSelectedId(null)
    }
  }
  const copyName = async () => {
    if (!selected) return
    try { await navigator.clipboard.writeText(selected.name); setCopyStatus("已复制") }
    catch { setCopyStatus("复制不可用，请手动选择名称") }
  }
  const counts = { online: 0, offline: 0, unknown: 0 }
  for (const node of nodes ?? []) counts[nodeStatus(node)]++

  if (closed) return <Entry title="访问权限已变化"><p>旧快照已清除。请重新验证身份后读取节点。</p><a className="solid-button" href="/admin/">前往管理登录 <ArrowUpRight size={18} /></a><button className="text-link" onClick={() => location.reload()}>重新读取</button></Entry>

  return <div className={`rhine-app${detail ? " is-detail" : ""}${reduceMotion ? " reduce-motion" : ""}`}>
    <a href="#main-content" className="skip-link">跳转至主要内容</a>
    <header className="site-header">
      <a href="/" className="site-brand" onClick={(event) => { if (!event.ctrlKey && !event.metaKey && event.button === 0) { event.preventDefault(); navigate("/") } }}>
        <span className="site-title" data-testid="site-title">{site.site_name}</span>
        <span className="brand-kicker">INFRASTRUCTURE OBSERVATORY</span>
        <span className="brand-subtitle">OBSERVATION <b>OS</b><i aria-hidden="true" /></span>
      </a>
      <nav className="top-nav" aria-label="主导航">
        <button onClick={() => openIndex()} data-testid="open-index"><Search size={20} /><span>节点索引</span><kbd>/</kbd></button>
        <button onClick={() => openIndex("favorites")}><Star size={17} /><span>关注</span><b className="tabular">{String(favorites.length).padStart(2, "0")}</b></button>
        <button onClick={() => setSettings(true)} aria-label="显示设置"><Settings2 size={19} /></button>
        <a href="/admin/" className="admin-link">管理 <ArrowUpRight size={14} /></a>
      </nav>
    </header>

    <section className="fleet-bar" aria-label="节点汇总">
      <div className="fleet-counts"><span className="eyebrow">FLEET / {stale ? "上次快照" : "节点概览"}</span><b>{nodes === null ? "--" : nodes.length}<small>节点</small></b>
        <button onClick={() => openIndex("online")}><i className="status-dot status-online" />在线 {nodes === null ? "--" : counts.online}</button>
        <button onClick={() => openIndex("offline")}><i className="status-dot status-offline" />离线 {nodes === null ? "--" : counts.offline}</button>
        {counts.unknown > 0 && <button onClick={() => openIndex("unknown")}>待上报 {counts.unknown}</button>}
      </div>
      <div className={`connection-state connection-${connection}`} data-testid="connection-status" data-transport={JSON.stringify(diagnostics)} data-received-at={receivedAt ?? ""}><i aria-hidden="true" />{CONNECTION[connection]}<span>{receivedAt ? stamp(receivedAt) : "--"} CST</span></div>
    </section>
    {configError && <div className="notice" role="status">站点配置刷新失败：{configError}。当前标题仍为上次读取值。<button onClick={() => void onRevalidate()}>重试</button></div>}
    {stale && <div className="notice" role="status">浏览器暂未取得新数据；以下状态与指标为上次快照，不代表节点刚刚离线。{receivedAt && ` 最后接收：${stamp(receivedAt, true)}。`}</div>}
    {selectionNotice && !detail && <div className="notice" role="status">{selectionNotice}</div>}

    <main id="main-content" tabIndex={-1}>
      {nodes === null ? <section className="empty-state"><p className="eyebrow">ACQUIRING TELEMETRY</p><h1>{error ? "数据连接暂时不可用" : "正在连接节点"}</h1><p>{error || "正在读取真实快照，不填充示例数据。"}</p>{error && <button className="text-link" onClick={() => location.reload()}>重新连接 <ArrowRight size={18} /></button>}</section>
        : nodes.length === 0 ? <section className="empty-state"><p className="eyebrow">NO VISIBLE RECORDS</p><h1>暂无可见节点</h1><p>当前访问权限下没有节点可展示。添加或调整节点请前往管理后台。</p><a href="/admin/" className="text-link">打开管理后台 <ArrowUpRight size={18} /></a></section>
          : detail ? <article className="node-file" data-testid="node-detail">
            <div className="detail-toolbar">
              <button className="back-link" onClick={back}><ArrowLeft size={18} />返回来源</button>
              {selected && <div className="detail-actions">
                <span className="action-feedback" role="status">{copyStatus}</span>
                <button className="text-link" aria-pressed={favorites.includes(selected.id)} onClick={() => toggleFavorite(selected.id)}><Star size={16} fill={favorites.includes(selected.id) ? "currentColor" : "none"} />{favorites.includes(selected.id) ? "已关注" : "关注节点"}</button>
                <button className="text-link" onClick={() => void copyName()}>{copyStatus === "已复制" ? <Check size={16} /> : <Copy size={16} />}复制名称</button>
              </div>}
            </div>
            {!selected ? <div className="empty-state"><h1>节点当前不可用</h1><p>节点可能已删除、被隐藏，或不在当前访问权限范围内。</p><button className="text-link" onClick={() => openIndex()}>查看节点索引 <ArrowRight size={18} /></button></div>
              : <>
                <header className="detail-identity" ref={identityRef}>
                  <div className="detail-title">
                    <div className="file-label"><span className="file-label-kind">NODE FILE</span><span className="file-label-group">{selected.group || "未分组"}</span></div>
                    <h1 className="node-heading" ref={headingRef} tabIndex={-1} data-document-reveal>{selected.name}</h1>
                    <div className="detail-subtitle"><NodeStatus node={selected} stale={stale} /><span>{selected.os || "系统信息待上报"}</span></div>
                  </div>
                  <dl className="detail-facts">
                      <div><dt>PROCESSOR / 处理器</dt><dd data-document-reveal>{selected.cpu_name || "--"}</dd></div>
                      <div><dt>ARCHITECTURE / 架构</dt><dd data-document-reveal>{selected.arch || "--"}{selected.cpu_cores > 0 ? ` / ${selected.cpu_cores} 核` : ""}</dd></div>
                      <div><dt>UPTIME / 运行时长</dt><dd>{metric(selected.metrics?.uptime, uptime)}</dd></div>
                      <div><dt>LAST REPORT / 最近上报</dt><dd>{selected.last_seen > 0 ? stamp(selected.last_seen * 1000, true) : "--"}</dd></div>
                  </dl>
                </header>
                <div className="detail-tabbar">
                    <div className="detail-tabs" role="tablist" aria-label="节点信息">
                      {([["overview", "概况"], ["resources", "资源趋势"], ["latency", "网络探测"]] as const).map(([value, label], index) => <button key={value} id={`tab-${value}`} data-testid={`tab-${value === "latency" ? "network" : value}`} role="tab" aria-selected={tab === value} aria-controls={`panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                        event.preventDefault()
                        const next = (["overview", "resources", "latency"] as const)[(index + (event.key === "ArrowLeft" ? 2 : 1)) % 3]
                        setTab(next); document.getElementById(`tab-${next}`)?.focus()
                      }}><span>0{index + 1}</span>{label}</button>)}
                    </div>
                    {tab !== "overview" && <div className="live-resource-strip" aria-label="当前资源使用率">
                      <span>CPU <b>{percentLabel(displayPercent(selected, "cpu"))}</b></span>
                      <span>MEM <b>{percentLabel(displayPercent(selected, "mem"))}</b></span>
                      <span>DISK <b>{percentLabel(displayPercent(selected, "disk"))}</b></span>
                    </div>}
                </div>
                {tab === "overview" ? <section className="detail-layout" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" ref={overviewRef}>
                    <InstrumentPlate node={selected} />
                    <div className="overview-body">
                      <div className="overview-head"><h2 data-document-reveal>NETWORK / 网络传输</h2><span>TRAFFIC OBSERVATION</span></div>
                      <div className="detail-rates"><MetricReadout label="上行 / UPLOAD" value={metric(selected.metrics?.net_tx, rate)} icon={<ArrowUp size={18} />} /><MetricReadout label="下行 / DOWNLOAD" value={metric(selected.metrics?.net_rx, rate)} icon={<ArrowDown size={18} />} /></div>
                      <dl className="secondary-facts"><div><dt>本月上行</dt><dd>{metric(selected.month_tx, bytes)}</dd></div><div><dt>本月下行</dt><dd>{metric(selected.month_rx, bytes)}</dd></div><div><dt>内核</dt><dd>{selected.kernel || "--"}</dd></div><div><dt>Agent</dt><dd>{selected.agent_version || "--"}</dd></div></dl>
                      <SnapshotNote node={selected} stale={stale} receivedAt={receivedAt} />
                    </div>
                  </section>
                  : <section className="history-region" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}><Suspense fallback={<p className="notice">正在载入历史视图...</p>}><NodeHistory key={`${selected.id}-${tab}`} node={selected} historyDays={site.history_days} mode={tab} reduceMotion={reduceMotion} /></Suspense></section>}
              </>}
          </article> : <section className="briefing" data-testid="briefing" ref={briefingRef}
            onFocusCapture={carousel.onFocusCapture} onBlurCapture={carousel.onBlurCapture}
            onPointerDownCapture={carousel.onPointerDownCapture}>
            <ArchiveStack nodes={visibleNodes} selectedId={selectedId} stale={stale} onSelect={(id) => { carousel.cancelWheel(); chooseNode(id) }} wheelOffset={carousel.wheelOffset} wheelActive={carousel.wheelActive} />
            <div className="brief-content">
              <div className="eyebrow">TELEMETRY ARCHIVE <span>/</span> {selected?.group || "未分组"}</div>
              {selected ? <div className="brief-data">
                <h1 className="node-heading">{selected.name}</h1>
                <div className="brief-status"><NodeStatus node={selected} stale={stale} /><span>{selected.os || "系统待上报"} {selected.arch}</span></div>
                <BriefingTrends node={selected} stale={stale} active={!route.index && !settings && !carousel.wheelActive && (connection === "live" || connection === "polling")} />
                <SnapshotNote node={selected} stale={stale} receivedAt={receivedAt} />
                <button className="brief-access" data-testid="brief-detail" onClick={() => openNode(selected.id)}><span>查看节点详情 <small>ACCESS NODE FILE</small></span><ArrowRight size={28} /></button>
              </div> : <div className="brief-data"><h1 className="node-heading">节点当前不可用</h1><p>已停止显示旧指标。请重新选择一个节点。</p><button className="text-link" onClick={() => openIndex()}>打开节点索引 <ArrowRight size={18} /></button></div>}
            </div>
            <div className="archive-navigation">
              {visibleNodes.length > 1 && <>
                <span className="rotation-progress" data-testid="rotation-progress" data-running={carousel.running} aria-hidden="true"><i key={carousel.progressKey} style={{ animationDuration: `${ROTATION_MS}ms`, animationPlayState: carousel.running ? "running" : "paused" }} /></span>
                <button className="rotation-toggle" data-testid="rotation-toggle" data-carousel-toggle
                  aria-label={carousel.motionDisabled ? "已停用自动切换：减少动态效果" : carousel.paused ? "继续自动切换" : "暂停自动切换"}
                  title={carousel.motionDisabled ? "减少动态效果已停用自动切换" : carousel.paused ? "继续自动切换" : "暂停自动切换"}
                  disabled={carousel.motionDisabled} onClick={carousel.toggle}>
                  {carousel.paused || carousel.motionDisabled ? <Play size={13} /> : <Pause size={13} />}
                </button>
              </>}
              <div className="selection-count"><span className="eyebrow">ARCHIVE / SELECT</span><div><b>{position < 0 ? "--" : String(position + 1).padStart(2, "0")}</b><span>/ {String(visibleNodes.length).padStart(2, "0")}</span></div></div>
              <div className="node-switcher"><button aria-label="上一节点" data-testid="previous-node" onClick={() => manualStep(-1)} disabled={visibleNodes.length < 2}><ArrowLeft size={24} /></button><div className="node-ticks" aria-hidden="true">{visibleNodes.slice(Math.max(0, position - 4), Math.max(0, position - 4) + 9).map((node) => <i key={node.id} className={node.id === selectedId ? "active" : ""} />)}</div><button aria-label="下一节点" data-testid="next-node" onClick={() => manualStep(1)} disabled={visibleNodes.length < 2}><ArrowRight size={24} /></button></div>
              <label className="group-picker"><span className="eyebrow">COLLECTION / 分组</span><select value={JSON.stringify(group)} onChange={(event) => selectGroup(JSON.parse(event.target.value))}><option value="null">全部节点</option>{groups.map((value) => <option key={value} value={JSON.stringify(value)}>{value}</option>)}{nodes.some((node) => !node.group) && <option value={'""'}>未分组</option>}</select></label>
            </div>
            <p className="keyboard-help">← → 切换节点 <span>/</span> ENTER 查看详情 <span>/</span> / 检索</p>
          </section>}
    </main>
    <footer className="site-footer"><span><i aria-hidden="true" />{site.authed ? "已登录访问" : "公开状态页"}</span><span>TIMEZONE / ASIA·SHANGHAI</span><span>POWERED BY <b>MONITOR</b><i className="footer-mark" /></span></footer>
    <NodeIndex open={route.index} entry={indexEntry} nodes={nodes ?? []} filters={filters} onFilters={setFilters} favorites={favorites} stale={stale} receivedAt={receivedAt} onClose={closeIndex} onOpen={openNode} onFavorite={toggleFavorite} />
    <dialog className="settings-dialog" ref={settingsRef} aria-labelledby="settings-heading" onCancel={(event) => { event.preventDefault(); setSettings(false) }}>
      <div className="dialog-heading"><span className="eyebrow">DISPLAY / 本机显示偏好</span><button aria-label="关闭显示设置" onClick={() => setSettings(false)}><X size={21} /></button></div>
      <h2 id="settings-heading">显示设置</h2><label className="motion-option"><input type="checkbox" checked={reduceMotion} onChange={(event) => setReduceMotion(event.target.checked)} /><span>减少动态效果<small>关闭位移与渐入；同时尊重系统的减少动态效果设置。</small></span></label><p>仅影响本浏览器的主题显示。站点名称直接读取 Monitor 的“站点名称”配置。</p><a className="text-link" href="/admin/">前往管理后台 <ArrowUpRight size={16} /></a>
    </dialog>
  </div>
}

function MetricReadout({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return <div className="metric-readout"><span>{label}</span><strong>{icon}{value}</strong></div>
}
