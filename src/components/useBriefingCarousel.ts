import { useCallback, useEffect, useEffectEvent, useRef, useState, type FocusEvent, type RefObject } from "react"
import { createRotationClock, createWheelPhysics, createWheelStepper, isCardWheel, type WheelPhysicsFrame } from "../lib/carousel"

type Options = {
  active: boolean
  reduceMotion: boolean
  cycle: string
  collection: string
  region: RefObject<HTMLElement | null>
  onStep: (direction: number) => void
}

export function useBriefingCarousel({ active, reduceMotion, cycle, collection, region, onStep }: Options) {
  const clock = useRef<ReturnType<typeof createRotationClock> | null>(null)
  const wheelPhysics = useRef(createWheelPhysics())
  const wheelStepper = useRef(createWheelStepper())
  const wheelFrame = useRef<number | null>(null)
  const wheelBusy = useRef(false)
  const [wheelState, setWheelState] = useState({ offset: 0, active: false })
  const [wheelCycle, setWheelCycle] = useState(0)
  const [paused, setPaused] = useState(false)
  const [hidden, setHidden] = useState(() => document.hidden)
  const [systemReduced, setSystemReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches)
  const [keyboardFocus, setKeyboardFocus] = useState(false)
  const [holding, setHolding] = useState(false)
  const motionDisabled = reduceMotion || systemReduced
  const running = active && !motionDisabled && !paused && !hidden && !keyboardFocus && !holding && !wheelState.active
  const progressKey = `${cycle}:${active}:${motionDisabled}:${wheelCycle}`
  const cancelWheel = useCallback(() => {
    if (wheelFrame.current !== null) cancelAnimationFrame(wheelFrame.current)
    wheelFrame.current = null
    wheelPhysics.current.reset()
    wheelStepper.current = createWheelStepper()
    wheelBusy.current = false
    setWheelState({ offset: 0, active: false })
  }, [])

  useEffect(() => {
    const focused = document.activeElement
    // oxlint-disable-next-line react/set-state-in-effect -- A keyed node change can remove the focused control without firing blur.
    setKeyboardFocus(Boolean(active && focused && region.current?.contains(focused)
      && focused.matches(":focus-visible") && !focused.closest("[data-carousel-toggle]")))
    if (!active) setHolding(false)
  }, [active, cycle, region])
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)")
    const visibility = () => {
      setHidden(document.hidden)
      if (document.hidden) cancelWheel()
    }
    const motion = () => setSystemReduced(media.matches)
    const release = () => setHolding(false)
    document.addEventListener("visibilitychange", visibility)
    media.addEventListener("change", motion)
    window.addEventListener("pointerup", release)
    window.addEventListener("pointercancel", release)
    window.addEventListener("blur", release)
    return () => {
      document.removeEventListener("visibilitychange", visibility)
      media.removeEventListener("change", motion)
      window.removeEventListener("pointerup", release)
      window.removeEventListener("pointercancel", release)
      window.removeEventListener("blur", release)
    }
  }, [cancelWheel])

  const advance = useEffectEvent(() => {
    if (running && !wheelBusy.current && !document.hidden) onStep(1)
  })
  useEffect(() => {
    const timer = createRotationClock(advance, {
      now: () => performance.now(),
      schedule: (callback, delay) => {
        const timeout = window.setTimeout(callback, delay)
        return () => window.clearTimeout(timeout)
      },
    })
    clock.current = timer
    return () => timer.pause()
  }, [])
  useEffect(() => { clock.current?.reset() }, [progressKey])
  useEffect(() => {
    if (!running) return
    const timer = clock.current
    timer?.resume()
    return () => timer?.pause()
  }, [running, progressKey])

  const wheelStep = useEffectEvent((direction: number) => onStep(direction))
  useEffect(() => {
    const element = region.current
    if (!active || hidden || !element) return
    const paint = (frame: WheelPhysicsFrame) => {
      if (frame.steps !== 0) wheelStep(frame.steps)
      wheelBusy.current = frame.active
      setWheelState({ offset: frame.offset, active: frame.active })
    }
    const render = (time: number) => {
      wheelFrame.current = null
      if (document.hidden) {
        cancelWheel()
        return
      }
      const frame = wheelPhysics.current.tick(time)
      paint(frame)
      if (frame.active) wheelFrame.current = requestAnimationFrame(render)
    }
    const wheel = (event: WheelEvent) => {
      // Touch/mobile keeps ordinary document scrolling; zoom and form controls stay native.
      if (!matchMedia("(min-width: 801px) and (pointer: fine)").matches || !isCardWheel(event)
        || document.querySelector("dialog[open]") || !(event.target instanceof Element)
        || event.target.closest("input, select, textarea, [contenteditable]")
        || !event.target.closest(".archive-stage, .node-switcher")) return
      event.preventDefault()
      clock.current?.reset()
      if (!wheelBusy.current) setWheelCycle((value) => value + 1)
      if (motionDisabled) {
        const direction = wheelStepper.current(event, performance.now())
        if (direction !== 0) wheelStep(direction)
        return
      }
      const frame = wheelPhysics.current.push(event, performance.now())
      if (!frame) return
      paint(frame)
      if (wheelFrame.current === null) wheelFrame.current = requestAnimationFrame(render)
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => {
      element.removeEventListener("wheel", wheel)
      cancelWheel()
    }
  }, [active, hidden, motionDisabled, collection, region, cancelWheel])

  const onFocusCapture = (event: FocusEvent<HTMLElement>) => {
    setKeyboardFocus(event.target.matches(":focus-visible")
      && !event.target.closest("[data-carousel-toggle]"))
  }
  const onBlurCapture = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardFocus(false)
  }

  return {
    paused, running, motionDisabled, progressKey,
    wheelOffset: wheelState.offset, wheelActive: wheelState.active, cancelWheel,
    toggle: () => setPaused((value) => !value),
    onFocusCapture, onBlurCapture,
    onPointerDownCapture: () => { setKeyboardFocus(false); setHolding(true) },
  }
}
