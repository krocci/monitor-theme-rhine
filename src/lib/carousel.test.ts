/// <reference types="node" />
import assert from "node:assert/strict"
import { archiveCardPose, createRotationClock, createWheelPhysics, createWheelStepper, isCardWheel, ROTATION_MS } from "./carousel.ts"

let now = 0
let elapsed = 0
const tasks: { callback: () => void; due: number; cancelled: boolean; fired: boolean }[] = []
const clock = createRotationClock(() => { elapsed++ }, {
  now: () => now,
  schedule: (callback, delay) => {
    const task = { callback, due: now + delay, cancelled: false, fired: false }
    tasks.push(task)
    return () => { task.cancelled = true }
  },
})
const advance = (delta: number) => {
  now += delta
  for (const task of tasks) {
    if (!task.cancelled && !task.fired && task.due <= now) { task.fired = true; task.callback() }
  }
}
clock.resume()
for (let count = 0; count < 3; count++) {
  advance(2_000)
  clock.resume()
  assert.equal(elapsed, 0)
}
advance(2_000)
assert.equal(elapsed, 1, "Repeated refreshes must not postpone rotation")
assert.equal(tasks.length, 1, "Only one timeout may be live")
clock.reset()
clock.resume()
advance(3_000)
clock.pause()
advance(30_000)
assert.equal(elapsed, 1, "Paused time must not advance cards")
clock.resume()
advance(4_999)
assert.equal(elapsed, 1)
advance(1)
assert.equal(elapsed, 2, "Pause/resume preserves remaining time")
clock.reset()
clock.resume()
advance(7_900)
const oldCallback = tasks[tasks.length - 1].callback
clock.reset()
clock.resume()
oldCallback()
advance(100)
assert.equal(elapsed, 2, "Cancelled or stale callbacks must not advance the next selection")
advance(ROTATION_MS - 100)
assert.equal(elapsed, 3, "Manual reset grants the new selection a full interval")
clock.reset()
clock.resume()
clock.pause()
advance(ROTATION_MS * 10)
assert.equal(elapsed, 3, "Cleanup must cancel pending rotation")

const wheel = (deltaY: number, patch = {}) => ({ deltaX: 0, deltaY, deltaMode: 0, ...patch })
for (const event of [
  wheel(0), wheel(NaN), wheel(Infinity), wheel(120, { ctrlKey: true }),
  wheel(120, { metaKey: true }), wheel(120, { shiftKey: true }), wheel(10, { deltaX: 50 }), wheel(10, { deltaX: NaN }),
]) assert.equal(isCardWheel(event), false)

const mouse = createWheelStepper()
assert.equal(mouse(wheel(120), 0), 1)
assert.equal(mouse(wheel(120), 100), 1, "Reduced motion must not lock subsequent input")
assert.equal(mouse(wheel(-120), 110), -1, "Reduced motion must allow immediate reversal")
assert.equal(mouse(wheel(3, { deltaMode: 1 }), 1_600), 0)
assert.equal(mouse(wheel(1, { deltaMode: 1 }), 1_630), 1)
assert.equal(mouse(wheel(-1, { deltaMode: 2 }), 2_400), -1)

const touchpad = createWheelStepper()
assert.equal(touchpad(wheel(20), 0), 0)
assert.equal(touchpad(wheel(25), 16), 0)
assert.equal(touchpad(wheel(20), 32), 1)
assert.equal(touchpad(wheel(20), 48), 0)
assert.equal(touchpad(wheel(20), 64), 0)
assert.equal(touchpad(wheel(20), 80), 1, "A continued gesture can select another card")
assert.equal(touchpad(wheel(-70), 2_500), -1)

const reversal = createWheelStepper()
assert.equal(reversal(wheel(40), 0), 0)
assert.equal(reversal(wheel(-40), 20), 0)
assert.equal(reversal(wheel(-30), 40), -1)
const isolated = createWheelStepper()
assert.equal(isolated(wheel(40), 0), 0)
assert.equal(isolated(wheel(40), 500), 0)
assert.equal(isolated(wheel(20), 520), 1)

{
  const physics = createWheelPhysics()
  let frame = physics.push(wheel(120), 0)!
  let crossed = frame.steps
  assert.ok(crossed + frame.offset > 0, "Input moves the cards before the first animation frame")
  assert.notEqual(frame.offset, 0, "A mouse notch has a continuous fractional position")
  for (let time = 16; time <= 2_000; time += 16) {
    frame = physics.tick(time)
    crossed += frame.steps
    if (!frame.active) break
  }
  assert.equal(crossed, 1, "a mouse wheel notch settles on one next card")
  assert.equal(frame.offset, 0, "The selected card and resting position agree")
  assert.equal(frame.active, false, "The timer can resume once inertia and snapping end")
}

{
  const physics = createWheelPhysics()
  let selected = 0
  let position = 0
  const sample = (frame: NonNullable<ReturnType<typeof physics.push>>) => {
    selected += frame.steps
    position = selected + frame.offset
    return frame
  }
  sample(physics.push(wheel(120), 0)!)
  sample(physics.tick(220))
  const before = position
  assert.equal(sample(physics.push(wheel(-30), 220)!).active, true)
  assert.ok(position < before, "Reverse input moves immediately while the previous snap is active")
  const afterInput = position
  sample(physics.tick(236))
  assert.ok(position < afterInput, "The previous forward velocity does not overpower reversal")
  const afterReverse = position
  sample(physics.push(wheel(40), 236)!)
  assert.ok(position > afterReverse, "Another reversal is accepted in the same frame")
}

{
  const physics = createWheelPhysics()
  let selected = 0
  let previous = 0
  for (let time = 0; time <= 400; time += 8) {
    const frame = physics.push(wheel(8), time)!
    selected += frame.steps
    const position = selected + frame.offset
    assert.ok(position > previous, "Every small trackpad sample contributes during ongoing movement")
    previous = position
  }
  assert.ok(selected >= 2, "A sustained gesture can move through several cards")
  let frame = physics.tick(416)
  selected += frame.steps
  for (let time = 432; time <= 2_000 && frame.active; time += 16) {
    frame = physics.tick(time)
    selected += frame.steps
  }
  assert.equal(frame.active, false)
  assert.equal(frame.offset, 0)
}

{
  const physics = createWheelPhysics()
  const first = physics.push(wheel(720), 0)!
  const second = physics.push(wheel(720), 0)!
  assert.ok(first.steps + second.steps >= 7, "Multiple boundary crossings in one frame are retained")
  assert.ok(Math.abs(second.offset) <= 0.5)
  physics.push(wheel(-120), 16)
  physics.reset()
  const frame = physics.tick(32)
  assert.equal(frame.active, false, "reset cancels pending wheel momentum")
  assert.equal(frame.steps, 0)
  assert.equal(frame.offset, 0)
}

{
  const settle = (event: ReturnType<typeof wheel>, interval: number) => {
    const physics = createWheelPhysics()
    let frame = physics.push(event, 0)!
    let selected = frame.steps
    for (let time = interval; time <= 3_000 && frame.active; time += interval) {
      frame = physics.tick(time)
      selected += frame.steps
    }
    assert.equal(frame.active, false)
    return selected + frame.offset
  }
  assert.equal(settle(wheel(120), 8), 1)
  assert.equal(settle(wheel(120), 33), 1, "The same notch settles identically at 30 and 120 fps")
  assert.equal(settle(wheel(7.5, { deltaMode: 1 }), 16), 1)
  assert.equal(settle(wheel(0.25, { deltaMode: 2 }), 16), 1)
  assert.equal(settle(wheel(-120), 16), -1)
  assert.equal(settle(wheel(4), 16), 0, "A tiny isolated movement returns smoothly to its nearest card")
  const physics = createWheelPhysics()
  assert.equal(physics.push(wheel(120, { ctrlKey: true }), 0), null)
  assert.deepEqual(physics.tick(16), { offset: 0, steps: 0, active: false })
}

{
  const first = archiveCardPose(0, 6, 0, 0)
  const next = archiveCardPose(1, 6, 0, 0)
  const firstMoved = archiveCardPose(0, 6, 0, 0.2)
  const nextMoved = archiveCardPose(1, 6, 0, 0.2)
  assert.ok(firstMoved.focus < first.focus && nextMoved.focus > next.focus,
    "Focus passes continuously between individual cards")
  assert.notEqual(firstMoved.slot - first.slot, nextMoved.slot - next.slot,
    "Cards move relative to each other, not as a translated stack")
  for (let index = 0; index < 6; index++) {
    const before = archiveCardPose(index, 6, 5, 0.499)
    const after = archiveCardPose(index, 6, 0, -0.499)
    assert.ok(Math.abs(before.slot - after.slot) < 0.01, "Wrapping selection must not teleport cards")
    assert.deepEqual(archiveCardPose(index, 6, 6), archiveCardPose(index, 6, 0))
  }
  const many = Array.from({ length: 20 }, (_, index) => archiveCardPose(index, 20, 0, 0.3))
  assert.ok(many.filter((pose) => pose.opacity > 0).length <= 7, "Only the nearby archive cards are shown")
  assert.deepEqual(archiveCardPose(0, 1, 0), { slot: 0, focus: 1, depth: 0, opacity: 1 })
}

console.log("carousel: timer lifecycle, continuous input, reversal, inertia, snapping, reduced motion, unit modes and card continuity passed")
