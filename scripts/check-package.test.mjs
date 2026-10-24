import assert from "node:assert/strict"
import { test } from "node:test"
import { gzipSync, gunzipSync } from "node:zlib"
import { buildArchive, inspectArchive, inspectEntries, LIMITS } from "./check-package.mjs"

const entry = (name, text, type = "file") => ({ name, data: Buffer.from(text), type })
const valid = () => [
  entry("theme.json", JSON.stringify({ name: "Rhine", short: "rhine", description: "", version: "0.1.0", author: "local", url: "" })),
  entry("dist/", "", "directory"),
  entry("dist/index.html", '<!doctype html><title>Monitor</title><script type="module" src="/assets/main.js"></script>'),
  entry("dist/assets/", "", "directory"),
  entry("dist/assets/main.js", 'document.title = "Monitor";'),
]

test("portable theme tar round-trips with hub limits and an integrity hash", () => {
  const archive = buildArchive(valid())
  const result = inspectArchive(archive)
  assert.equal(result.theme.short, "rhine")
  assert.equal(result.entries, 5)
  assert.equal(result.files, 3)
  assert.equal(result.sha256.length, 64)
  assert.ok(result.compressedBytes < LIMITS.compressed)
})

test("manifest cannot overwrite built-in theme or omit the HTML shell", () => {
  const entries = valid()
  entries[0].data = Buffer.from(entries[0].data.toString().replace('"rhine"', '"default"'))
  assert.throws(() => inspectEntries(entries), /short=default/)
  assert.throws(() => inspectEntries(valid().filter((item) => item.name !== "dist/index.html")), /dist\/index/)
})

test("release excludes 3D, media, service worker, remote code and fixture payloads", () => {
  const cases = [
    entry("dist/model.glb", "x"),
    entry("dist/intro.mp3", "x"),
    entry("dist/sw.js", "x"),
    entry("dist/worker.js", 'navigator.serviceWorker.register("/worker.js")'),
    entry("dist/remote.html", '<script src="https://invalid.example/runtime"></script>'),
    entry("dist/remote.js", 'import("https://invalid.example/runtime.js")'),
    entry("dist/fixture.js", '"synthetic-local-only"'),
    entry("dist/main.js.map", "{}"),
  ]
  for (const bad of cases) assert.throws(() => inspectEntries([...valid(), bad]), undefined, bad.name)
})

test("path conflicts, traversal, symlinks and duplicates fail closed", () => {
  for (const bad of [
    entry("../escape", "x"),
    entry("/absolute", "x"),
    entry("C:\\absolute", "x"),
    entry("dist/index.html", "duplicate"),
    entry("dist/link", "", "symlink"),
    entry("dist/assets/main.js/child", "x"),
  ]) assert.throws(() => inspectEntries([...valid(), bad]))
})

test("hub file/count/expanded bounds are enforced before packing", () => {
  assert.throws(() => inspectEntries([...valid(), { name: "dist/huge.bin", type: "file", data: Buffer.alloc(LIMITS.file + 1) }]), /8 MiB/)
  const tooMany = Array.from({ length: LIMITS.entries + 1 }, (_, index) => entry(`entry-${index}`, ""))
  assert.throws(() => inspectEntries(tooMany), /2000 entries/)
  const block = Buffer.alloc(LIMITS.file)
  const tooLarge = Array.from({ length: 9 }, (_, index) => ({ name: `file-${index}`, type: "file", data: block }))
  assert.throws(() => inspectEntries(tooLarge), /64 MiB/)
})

test("truncated gzip, bad tar checksum and hidden tail payloads are rejected", () => {
  const archive = buildArchive(valid())
  assert.throws(() => inspectArchive(archive.subarray(0, archive.length - 5)))
  const stream = gunzipSync(archive)
  const broken = Buffer.from(stream)
  broken[0] ^= 1
  assert.throws(() => inspectArchive(gzipSync(broken)), /checksum/)
  assert.throws(() => inspectArchive(gzipSync(Buffer.concat([stream, Buffer.from("hidden")]))), /hidden/)
})
