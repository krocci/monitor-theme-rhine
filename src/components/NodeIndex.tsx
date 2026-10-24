import { useEffect, useMemo, useRef } from "react"
import { groupsOf, type Node } from "@/lib/api"
import { rate } from "@/lib/format"
import { displayPercent, finiteMetric, nodeStatus, percentLabel } from "@/lib/rhine"
import { NodeStatus, stamp } from "@/components/RhineVisuals"

export type IndexFilters = {
  query: string
  group: string | null
  status: "all" | "online" | "offline" | "unknown" | "favorites"
  sort: "default" | "name"
}

type Props = {
  open: boolean
  nodes: Node[]
  filters: IndexFilters
  onFilters: (filters: IndexFilters) => void
  favorites: number[]
  stale: boolean
  receivedAt: number | null
  onClose: () => void
  onOpen: (id: number) => void
  onFavorite: (id: number) => void
}

const STATUSES: { key: IndexFilters["status"]; label: string }[] = [
  { key: "all", label: "全部节点" },
  { key: "online", label: "在线" },
  { key: "offline", label: "离线" },
  { key: "unknown", label: "待确认" },
  { key: "favorites", label: "已关注" },
]

const speed = (value: unknown) => {
  const number = finiteMetric(value)
  return number === null ? "--" : rate(number)
}

const outsideDialog = (dialog: HTMLDialogElement, x: number, y: number) => {
  const bounds = dialog.getBoundingClientRect()
  return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom
}

export function NodeIndex({
  open, nodes, filters, onFilters, favorites, stale, receivedAt, onClose, onOpen, onFavorite,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const scrollTop = useRef(0)
  const opener = useRef<HTMLElement | null>(null)
  const backdropPress = useRef(false)
  const groupOptions = useMemo(() => {
    const options = groupsOf(nodes)
    if (nodes.some((node) => !node.group)) options.push("")
    if (filters.group !== null && !options.includes(filters.group)) options.push(filters.group)
    return options
  }, [nodes, filters.group])
  const favoriteIds = useMemo(() => new Set(favorites), [favorites])
  const rows = useMemo(() => {
    const query = filters.query.trim().toLocaleLowerCase("zh-CN")
    const visible = nodes.filter((node) => (
      (filters.group === null || (node.group ?? "") === filters.group)
      && (filters.status === "all"
        || (filters.status === "favorites" ? favoriteIds.has(node.id) : nodeStatus(node) === filters.status))
      && (!query || `${node.id} ${node.name} ${node.group ?? ""}`.toLocaleLowerCase("zh-CN").includes(query))
    ))
    return visible.sort(filters.sort === "name"
      ? (a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }) || a.id - b.id
      : (a, b) => a.sort - b.sort || a.id - b.id)
  }, [nodes, filters, favoriteIds])

  useEffect(() => {
    const panel = dialog.current
    if (!panel) return
    backdropPress.current = false
    if (open && !panel.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      panel.showModal()
      search.current?.focus({ preventScroll: true })
      if (list.current) list.current.scrollTop = scrollTop.current
    } else if (!open && panel.open) {
      if (list.current) scrollTop.current = list.current.scrollTop
      panel.close()
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
    }
  }, [open])

  const change = (patch: Partial<IndexFilters>) => {
    scrollTop.current = 0
    if (list.current) list.current.scrollTop = 0
    onFilters({ ...filters, ...patch })
  }
  const close = () => {
    backdropPress.current = false
    if (list.current) scrollTop.current = list.current.scrollTop
    onClose()
  }
  const enter = (id: number) => {
    if (list.current) scrollTop.current = list.current.scrollTop
    onOpen(id)
  }

  return (
    <dialog
      ref={dialog}
      className="rhine-index"
      data-testid="node-index"
      aria-labelledby="node-index-title"
      onPointerDownCapture={(event) => {
        backdropPress.current = event.isPrimary && event.button === 0
          && event.target === event.currentTarget
          && outsideDialog(event.currentTarget, event.clientX, event.clientY)
      }}
      onPointerCancelCapture={() => { backdropPress.current = false }}
      onClick={(event) => {
        const startedOutside = backdropPress.current
        backdropPress.current = false
        // Both ends must be on the backdrop; dragging from the panel is not dismissal.
        if (startedOutside && event.button === 0 && event.detail > 0
          && event.target === event.currentTarget
          && outsideDialog(event.currentTarget, event.clientX, event.clientY)) close()
      }}
      onCancel={(event) => { event.preventDefault(); close() }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
      }}
      onClose={() => { if (open) onClose() }}
    >
      <header className="rhine-index-header">
        <span className="eyebrow">OBSERVATION / NODE DIRECTORY</span>
        <button type="button" className="rhine-index-close" onClick={close} aria-label="关闭节点索引">
          <span>CLOSE</span><span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="rhine-index-heading">
        <h2 id="node-index-title">NODE INDEX</h2>
        <span>节点索引</span>
      </div>

      <label className="rhine-index-search">
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="m15 15 6 6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className="sr-only">搜索节点名称、分组或编号</span>
        <input
          ref={search}
          type="search"
          data-testid="index-search"
          value={filters.query}
          onChange={(event) => change({ query: event.target.value })}
          placeholder="搜索节点名称、分组或编号"
          autoComplete="off"
          spellCheck={false}
        />
        <kbd aria-hidden="true">ESC</kbd>
      </label>

      <div className="rhine-index-tools">
        <div className="rhine-index-filters" aria-label="按节点状态筛选">
          {STATUSES.map((status) => (
            <button
              key={status.key}
              type="button"
              className="rhine-index-filter"
              aria-pressed={filters.status === status.key}
              onClick={() => change({ status: status.key })}
            >
              {status.label}
            </button>
          ))}
        </div>
        <div className="rhine-index-selects">
          <label>
            <span className="sr-only">筛选分组</span>
            <select
              aria-label="筛选分组"
              value={filters.group === null ? "-1" : String(groupOptions.indexOf(filters.group))}
              onChange={(event) => {
                const index = Number(event.target.value)
                change({ group: index < 0 ? null : groupOptions[index] ?? null })
              }}
            >
              <option value="-1">全部分组</option>
              {groupOptions.map((group, index) => <option key={group} value={index}>{group || "未分组"}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">节点排序</span>
            <select
              aria-label="节点排序"
              value={filters.sort}
              onChange={(event) => change({ sort: event.target.value === "name" ? "name" : "default" })}
            >
              <option value="default">固定顺序</option>
              <option value="name">按名称排序</option>
            </select>
          </label>
        </div>
      </div>

      {stale && <p className="rhine-index-notice" role="status">连接中断 · 以下为最后已知数据，不代表当前节点状态。</p>}

      <div ref={list} className="rhine-index-list" onScroll={(event) => { scrollTop.current = event.currentTarget.scrollTop }}>
        <table className="rhine-index-table">
          <thead>
            <tr>
              <th scope="col">NODE / 节点与分组</th>
              <th scope="col">STATUS / 状态</th>
              <th scope="col">CPU</th>
              <th scope="col">MEM / 内存</th>
              <th scope="col">UP / 上行 · DOWN / 下行</th>
              <th scope="col">REPORT / 最近上报</th>
              <th scope="col"><span className="sr-only">节点操作</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((node) => {
              const state = nodeStatus(node)
              const favorite = favoriteIds.has(node.id)
              return (
                <tr key={node.id} data-node-id={node.id} data-stale={stale || state !== "online" ? "true" : undefined}>
                  <th scope="row" className="rhine-index-node">
                    <span className="rhine-index-id">N-{String(node.id).padStart(3, "0")}</span>
                    <div>
                      <button type="button" className="rhine-index-name" onClick={() => enter(node.id)}>{node.name}</button>
                      <span className="rhine-index-group">{node.group || "未分组"}</span>
                    </div>
                  </th>
                  <td className="rhine-index-status" data-label="状态"><NodeStatus node={node} stale={stale} /></td>
                  <td className="rhine-index-cpu" data-label="CPU">{percentLabel(displayPercent(node, "cpu"))}</td>
                  <td className="rhine-index-memory" data-label="内存">{percentLabel(displayPercent(node, "mem"))}</td>
                  <td className="rhine-index-network" data-label="上行 / 下行">
                    <span><span aria-hidden="true">↑ </span>{speed(node.metrics?.net_tx)}</span>
                    <span><span aria-hidden="true">↓ </span>{speed(node.metrics?.net_rx)}</span>
                  </td>
                  <td className="rhine-index-report" data-label="最近上报" title={node.last_seen > 0 ? stamp(node.last_seen * 1000, true) : undefined}>
                    {node.last_seen > 0 ? stamp(node.last_seen * 1000) : "--"}
                    {!node.last_seen && <small>尚未上报</small>}
                    {state === "offline" && <small>最后已知数据</small>}
                  </td>
                  <td className="rhine-index-actions">
                    <button
                      type="button"
                      className="rhine-index-favorite"
                      aria-label={`${favorite ? "取消关注" : "关注"} ${node.name}`}
                      aria-pressed={favorite}
                      title={favorite ? "取消本浏览器关注" : "关注到本浏览器"}
                      onClick={() => onFavorite(node.id)}
                    >
                      <span aria-hidden="true">{favorite ? "−" : "+"}</span>
                    </button>
                    <button type="button" className="rhine-index-open" aria-label={`查看 ${node.name} 详情`} onClick={() => enter(node.id)}>
                      <span aria-hidden="true">↗</span>
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && (
          <div className="rhine-index-empty" role="status">
            <strong>{nodes.length ? "没有匹配的节点" : "暂无节点"}</strong>
            <p>{nodes.length ? "试试其他名称、分组或状态筛选。" : "节点上报后会在这里显示；此处不会生成示例节点。"}</p>
            {nodes.length > 0 && (
              <button type="button" onClick={() => change({ query: "", group: null, status: "all" })}>清除筛选</button>
            )}
          </div>
        )}
      </div>

      <footer className="rhine-index-footer">
        <span>{rows.length} / {nodes.length} RECORDS · 个节点</span>
        <span>{receivedAt ? `${stale ? "上次快照" : "最后更新"} ${stamp(receivedAt)}` : "尚无快照"}</span>
      </footer>
    </dialog>
  )
}
