export const ROTATION_MS = 8_000

type Scheduler = {
  now: () => number
  schedule: (callback: () => void, delay: number) => () => void
}

export function createRotationClock(onElapsed: () => void, scheduler: Scheduler) {
  let remaining = ROTATION_MS
  let startedAt = 0
  let cancel: (() => void) | null = null
  let generation = 0
  const pause = () => {
    generation++
    if (!cancel) return
    cancel()
    cancel = null
    remaining = Math.max(0, remaining - (scheduler.now() - startedAt))
  }
  return {
    pause,
    reset: () => { pause(); remaining = ROTATION_MS },
    resume: () => {
      if (cancel) return
      const current = ++generation
      startedAt = scheduler.now()
      cancel = scheduler.schedule(() => {
        if (current !== generation) return
        cancel = null
        remaining = 0
        onElapsed()
      }, remaining)
    },
  }
}

type WheelSample = {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

export function isCardWheel(event: WheelSample) {
  return !event.ctrlKey && !event.metaKey && !event.shiftKey
    && Number.isFinite(event.deltaX) && Number.isFinite(event.deltaY) && event.deltaY !== 0
    && Math.abs(event.deltaY) > Math.abs(event.deltaX)
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const wheelPixels = (event: WheelSample) =>
  clamp(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 480 : 1), -720, 720)

/** Reduced motion keeps manual navigation, without inertia or a gesture lock. */
export function createWheelStepper() {
  let total = 0
  let previousAt = -Infinity
  return (event: WheelSample, now: number): -1 | 0 | 1 => {
    if (!isCardWheel(event)) return 0
    const quiet = now - previousAt >= 180
    previousAt = now
    const delta = wheelPixels(event)
    if (quiet || Math.sign(delta) !== Math.sign(total)) total = 0
    total += delta
    if (Math.abs(total) < 60) return 0
    const direction = total > 0 ? 1 : -1
    total = 0
    return direction
  }
}

export type WheelPhysicsFrame = {
  offset: number
  steps: number
  active: boolean
}

const CARD_PIXELS = 200
const FRICTION = 12
const SNAP_AFTER_MS = 80
const SPRING = 16

/**
 * Input moves the cards immediately. Between events velocity decays, then a
 * critically damped spring settles at the projected nearest card. Emitting
 * integer steps keeps the selected node and fractional visual on one position.
 */
export function createWheelPhysics() {
  let offset = 0
  let velocity = 0
  let frameAt: number | null = null
  let inputAt = -Infinity
  let target: number | null = null
  let active = false

  const reset = () => {
    offset = 0
    velocity = 0
    frameAt = null
    inputAt = -Infinity
    target = null
    active = false
  }

  const coast = (seconds: number) => {
    const decay = Math.exp(-FRICTION * seconds)
    offset += velocity * (1 - decay) / FRICTION
    velocity *= decay
  }

  const advance = (now: number) => {
    if (!active || frameAt === null) return
    const elapsed = Math.max(0, now - frameAt)
    const coastMs = target === null ? Math.min(elapsed, Math.max(0, inputAt + SNAP_AFTER_MS - frameAt)) : 0
    coast(coastMs / 1_000)
    const springMs = elapsed - coastMs
    if (target === null && now - inputAt >= SNAP_AFTER_MS) target = Math.round(offset + velocity / FRICTION)
    if (target !== null && springMs > 0) {
      const seconds = springMs / 1_000
      const distance = offset - target
      const coefficient = velocity + SPRING * distance
      const decay = Math.exp(-SPRING * seconds)
      offset = target + (distance + coefficient * seconds) * decay
      velocity = (velocity - SPRING * coefficient * seconds) * decay
    }
    frameAt = now
    if (target !== null && Math.abs(offset - target) < 0.0005 && Math.abs(velocity) < 0.01) {
      offset = target
      velocity = 0
      active = false
      target = null
      frameAt = null
    }
  }

  const frame = (): WheelPhysicsFrame => {
    const steps = Math.round(offset)
    offset -= steps
    if (target !== null) target -= steps
    return { offset, steps: steps || 0, active }
  }
  const push = (event: WheelSample, now: number): WheelPhysicsFrame | null => {
    if (!isCardWheel(event)) return null
    advance(now)
    const distance = wheelPixels(event) / CARD_PIXELS
    const seconds = clamp((now - inputAt) / 1_000, 0.016, 0.08)
    // Opposite input must reverse immediately, including during snap settling.
    const carried = Math.sign(distance) === Math.sign(velocity) ? velocity * 0.35 : 0
    velocity = clamp(carried + distance / seconds * 0.45, -10, 10)
    offset += distance
    target = null
    inputAt = now
    frameAt = now
    active = true
    return frame()
  }
  const tick = (now: number) => { advance(now); return frame() }
  return { push, tick, reset }
}

/** A flat fan with a curved return path keeps every card continuous at wraparound. */
export function archiveCardPose(index: number, count: number, selected: number, offset = 0) {
  if (count <= 1) return { slot: 0, focus: 1, depth: 0, opacity: 1 }
  const distance = ((index - selected - offset + count / 2) % count + count) % count - count / 2
  const visible = Math.min(count, 7)
  const angle = distance * Math.PI * 2 / visible
  const depth = (1 - Math.cos(angle)) / 2
  return {
    slot: (visible - 1) / 2 + Math.sin(angle) * (visible - 1) / 2 + depth * 0.4,
    focus: Math.max(0, 1 - Math.abs(distance)),
    depth,
    opacity: count > 7 ? clamp(3.5 - Math.abs(distance), 0, 1) : 1,
  }
}
