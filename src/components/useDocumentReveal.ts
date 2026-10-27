import { useLayoutEffect, type RefObject } from "react"

type TextLine = { left: number; top: number; right: number; bottom: number }

// Adapts RhineLabUI's text-line redaction approach. Attribution is in NOTICE/LICENSE.
export function useDocumentReveal(rootRef: RefObject<HTMLElement | null>, identity: string | null, reduced = false) {
  useLayoutEffect(() => {
    const root = rootRef.current
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)")
    if (!root || !identity || reduced || preference.matches || root.closest(".reduce-motion")
      || document.hidden || typeof Element.prototype.animate !== "function") return

    const fragments: { target: HTMLElement; line: TextLine }[] = []
    // Finish all layout reads before inserting masks. Live readings are not targets.
    for (const target of root.querySelectorAll<HTMLElement>("[data-document-reveal]")) {
      if (fragments.length >= 24) break
      const bounds = target.getBoundingClientRect()
      if (!bounds.width || !bounds.height) continue
      const range = document.createRange()
      range.selectNodeContents(target)
      const lines: TextLine[] = []
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue
        const existing = lines.find((line) => Math.abs(line.top - (rect.top - bounds.top)) < 3)
        if (existing) {
          existing.left = Math.min(existing.left, rect.left - bounds.left)
          existing.right = Math.max(existing.right, rect.right - bounds.left)
          existing.bottom = Math.max(existing.bottom, rect.bottom - bounds.top)
        } else {
          lines.push({ left: rect.left - bounds.left, top: rect.top - bounds.top, right: rect.right - bounds.left, bottom: rect.bottom - bounds.top })
        }
      }
      for (const line of lines) {
        if (fragments.length >= 24) break
        fragments.push({ target, line: {
          left: Math.max(0, line.left - 1),
          top: line.top - 1,
          right: Math.min(bounds.width, line.right + 1),
          bottom: line.bottom + 1,
        } })
      }
    }
    if (!fragments.length) return

    const covers: HTMLSpanElement[] = []
    const animations: Animation[] = []
    let finished = false
    let fallback: number | undefined
    const clear = () => {
      if (finished) return
      finished = true
      window.clearTimeout(fallback)
      window.removeEventListener("resize", clear)
      document.removeEventListener("visibilitychange", clear)
      preference.removeEventListener("change", clear)
      for (const animation of animations) animation.cancel()
      for (const cover of covers) cover.remove()
    }

    for (const [index, { target, line }] of fragments.entries()) {
      const cover = document.createElement("span")
      cover.className = "document-reveal-window"
      cover.setAttribute("aria-hidden", "true")
      Object.assign(cover.style, {
        left: `${line.left}px`, top: `${line.top}px`,
        width: `${Math.max(0, line.right - line.left)}px`,
        height: `${line.bottom - line.top}px`,
      })
      const ink = document.createElement("span")
      ink.className = "document-reveal-ink"
      cover.append(ink)
      target.append(cover)
      covers.push(cover)
      animations.push(ink.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(101%)" }],
        { duration: 740, delay: 60 + index / Math.max(1, fragments.length - 1) * 150, easing: "cubic-bezier(.6, 0, .12, 1)", fill: "both" },
      ))
    }

    // Navigation, resizing and hidden tabs always leave the real text readable.
    window.addEventListener("resize", clear, { once: true })
    document.addEventListener("visibilitychange", clear, { once: true })
    preference.addEventListener("change", clear, { once: true })
    fallback = window.setTimeout(clear, 1100)
    void Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(clear)
    return clear
  }, [rootRef, identity, reduced])
}
