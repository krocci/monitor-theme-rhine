/// <reference types="node" />
import assert from "node:assert/strict"
import { displayPercent, finiteMetric, nodeStatus, parseFavorites, percentLabel, shouldIgnoreShortcut } from "./rhine.ts"
import type { Node } from "./api.ts"

for (const value of [null, undefined, "", "0", NaN, Infinity, -1, false]) assert.equal(finiteMetric(value), null)
assert.equal(finiteMetric(0), 0)
assert.equal(finiteMetric(125), 125)

const metricNode = (metrics: unknown) => ({ metrics }) as Pick<Node, "metrics">
assert.equal(displayPercent(metricNode(null), "cpu"), null)
assert.equal(displayPercent(metricNode({ cpu: null }), "cpu"), null)
assert.equal(displayPercent(metricNode({ cpu: 0 }), "cpu"), 0)
assert.equal(displayPercent(metricNode({ cpu: 125 }), "cpu"), 125)
assert.equal(displayPercent(metricNode({ mem_used: 0, mem_total: 512 }), "mem"), 0)
assert.equal(displayPercent(metricNode({ mem_used: 0, mem_total: 0 }), "mem"), null)
assert.equal(displayPercent(metricNode({ mem_used: null, mem_total: 512 }), "mem"), null)
assert.equal(displayPercent(metricNode({ mem_used: 768, mem_total: 512 }), "mem"), 150)
assert.equal(displayPercent(metricNode({ disk_used: 512, disk_total: 1024 }), "disk"), 50)
assert.equal(displayPercent(metricNode({ disk_used: Infinity, disk_total: 1024 }), "disk"), null)
assert.equal(percentLabel(null), "--")
assert.equal(percentLabel(0), "0.0%")
assert.equal(percentLabel(125), "125.0%")

assert.equal(nodeStatus({ online: false, last_seen: 0 }), "unknown")
assert.equal(nodeStatus({ online: true, last_seen: 0 }), "unknown")
assert.equal(nodeStatus({ online: true, last_seen: 100, last_seen_ago: null }), "unknown")
assert.equal(nodeStatus({ online: true, last_seen: 100, last_seen_ago: 0 }), "online")
assert.equal(nodeStatus({ online: false, last_seen: 100, last_seen_ago: 99 }), "offline")
assert.equal(nodeStatus({ online: true, last_seen: NaN }), "unknown")

assert.deepEqual(parseFavorites(null), [])
assert.deepEqual(parseFavorites("{bad"), [])
assert.deepEqual(parseFavorites('{"ids":[1]}'), [])
assert.deepEqual(parseFavorites('[2,1,2,-1,0,1.5,"3",null,9007199254740992]'), [2, 1])
assert.deepEqual(parseFavorites(" ".repeat(128_001)), [])

const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Element")
class TestElement {
  protectedControl: boolean
  constructor(protectedControl: boolean) { this.protectedControl = protectedControl }
  closest(selector: string) {
    assert.ok(selector.includes(".recharts-wrapper"))
    assert.ok(selector.includes("[contenteditable]"))
    return this.protectedControl ? this : null
  }
}
Object.defineProperty(globalThis, "Element", { configurable: true, value: TestElement })
try {
  const key = (patch: object = {}) => ({
    defaultPrevented: false, isComposing: false, keyCode: 0, ctrlKey: false, metaKey: false, altKey: false,
    target: new TestElement(false), ...patch,
  }) as unknown as KeyboardEvent
  assert.equal(shouldIgnoreShortcut(key()), false)
  for (const patch of [
    { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { ctrlKey: true },
    { metaKey: true }, { altKey: true }, { target: new TestElement(true) },
  ]) assert.equal(shouldIgnoreShortcut(key(patch)), true)
} finally {
  if (elementDescriptor) Object.defineProperty(globalThis, "Element", elementDescriptor)
  else Reflect.deleteProperty(globalThis, "Element")
}
console.log("rhine helpers preserve unknown data, actual node status and protected keyboard controls")
