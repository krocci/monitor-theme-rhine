import { createHash } from "node:crypto"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gzipSync, gunzipSync } from "node:zlib"

// Monitor hub v1.5.0: src/api.rs MAX_THEME and src/frontend.rs unpack/publish.
export const LIMITS = Object.freeze({
  compressed: 32 * 1024 ** 2,
  expanded: 64 * 1024 ** 2,
  file: 8 * 1024 ** 2,
  entries: 2000,
  manifest: 64 * 1024,
  padding: 1024 ** 2,
  stream: 73 * 1024 ** 2,
})
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MEDIA = /\.(?:glb|gltf|fbx|obj|stl|mp3|ogg|wav|flac|aac|mp4|webm|mov|m4a)$/i
const TEXT = /\.(?:html|css|js|mjs|json|svg)$/i
const MOCK_MARKERS = [
  /synthetic-local-only/,
  /mock-hub\.mjs/,
  /__RHINE_TITLE_XSS__/,
  /127\.0\.0\.1:9911/,
  /Awaiting first report/,
  /Synthetic reference processor/,
]
const DISALLOWED_CODE = [
  { pattern: /\b(?:WebGLRenderer|WebGLRenderingContext|WebGL2RenderingContext|GLTFLoader)\b/, reason: "3D/WebGL runtime" },
  { pattern: /\b(?:navigator\s*\.\s*)?serviceWorker\b/, reason: "service worker" },
  { pattern: /(?:from\s*|import\s*\()\s*["'](?:three|@react-three\/)/, reason: "Three.js dependency" },
  { pattern: /(?:src\s*=\s*["']|import\s*\(\s*["']|from\s*["'])(?:https?:)?\/\/[^"'<>]*\.(?:m?js)(?:[?#][^"'<>]*)?["']/i, reason: "remote script" },
  { pattern: /<script\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\//i, reason: "remote script element" },
  { pattern: /(?:https?:)?\/\/[^"'`\s<>]+\.(?:m?js)(?:[?#][^"'`\s<>]*)?["'`]/i, reason: "remote JavaScript URL" },
  { pattern: /@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//i, reason: "remote stylesheet import" },
]

const requireThat = (condition, message) => {
  if (!condition) throw new Error(message)
}
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex")
const safeName = (name) => {
  const clean = name.replace(/^\.\//, "").replace(/\/$/, "")
  requireThat(clean && !clean.startsWith("/") && !/^[a-z]:/i.test(clean)
    && !clean.includes("\\") && !clean.includes("\0")
    && clean.split("/").every((part) => part && part !== "." && part !== ".."),
  `Unsafe archive path: ${name}`)
  return clean
}

export function inspectEntries(entries) {
  requireThat(entries.length <= LIMITS.entries, `Archive has more than ${LIMITS.entries} entries`)
  const paths = new Map()
  let expanded = 0
  let largestFile = 0
  let fileCount = 0
  for (const entry of entries) {
    requireThat(["file", "directory", "metadata"].includes(entry.type), `Unsupported entry type: ${entry.name}`)
    requireThat(entry.data.length <= LIMITS.file, `File exceeds 8 MiB: ${entry.name}`)
    expanded += entry.data.length
    requireThat(expanded <= LIMITS.expanded, "Expanded entry data exceeds 64 MiB")
    if (entry.type === "metadata") continue
    const name = safeName(entry.name)
    requireThat(!paths.has(name), `Duplicate archive path: ${name}`)
    paths.set(name, entry)
    if (entry.type === "directory") {
      requireThat(entry.data.length === 0, `Directory contains payload bytes: ${name}`)
      continue
    }
    largestFile = Math.max(largestFile, entry.data.length)
    fileCount++
    requireThat(!MEDIA.test(name), `3D/audio/video asset is outside this 2D theme's scope: ${name}`)
    requireThat(!/(?:^|\/)(?:sw\.js|service-worker[^/]*|workbox[^/]*)$/i.test(name), `Service worker artifact: ${name}`)
    if (name.startsWith("dist/")) {
      requireThat(!/(?:^|\/)(?:tests?|fixtures?|scripts|node_modules|\.git)(?:\/|$)/i.test(name), `Development artifact in dist: ${name}`)
      requireThat(!/\.(?:map|ts|tsx)$/i.test(name), `Source/development file in dist: ${name}`)
      if (TEXT.test(name)) {
        const text = entry.data.toString("utf8")
        for (const marker of MOCK_MARKERS) requireThat(!marker.test(text), `Local mock marker in dist: ${name}`)
        for (const rule of DISALLOWED_CODE) requireThat(!rule.pattern.test(text), `${rule.reason} found in ${name}`)
      }
    }
  }
  for (const [name] of paths) {
    const parts = name.split("/")
    while (parts.length > 1) {
      parts.pop()
      const parent = paths.get(parts.join("/"))
      requireThat(!parent || parent.type === "directory", `File/directory path conflict: ${name}`)
    }
  }
  const manifest = paths.get("theme.json")
  requireThat(manifest?.type === "file", "Archive root must contain theme.json")
  requireThat(manifest.data.length <= LIMITS.manifest, "theme.json exceeds 64 KiB")
  let theme
  try {
    theme = JSON.parse(manifest.data.toString("utf8"))
  } catch {
    throw new Error("theme.json is not valid UTF-8 JSON")
  }
  for (const field of ["name", "short", "description", "version", "author", "url"]) {
    requireThat(typeof theme[field] === "string", `theme.json requires string field: ${field}`)
  }
  requireThat(/^[A-Za-z0-9_-]+$/.test(theme.short), "theme.json short must use ASCII letters, numbers, hyphen or underscore")
  requireThat(theme.short !== "default", "This external theme must not overwrite short=default")
  requireThat(paths.get("dist/index.html")?.type === "file", "Archive root must contain dist/index.html")
  return { theme: { name: theme.name, short: theme.short, version: theme.version }, entries: entries.length, files: fileCount, expandedBytes: expanded, largestFileBytes: largestFile }
}

async function collect(root) {
  const entries = []
  const append = async (relative) => {
    const absolute = resolve(root, ...relative.split("/"))
    const stat = await lstat(absolute)
    requireThat(!stat.isSymbolicLink(), `Symlinks are not allowed in the release: ${relative}`)
    if (stat.isDirectory()) {
      entries.push({ name: `${relative}/`, type: "directory", data: Buffer.alloc(0) })
      for (const name of (await readdir(absolute)).sort()) await append(`${relative}/${name}`)
    } else {
      requireThat(stat.isFile(), `Non-regular file in release: ${relative}`)
      requireThat(stat.size <= LIMITS.file, `File exceeds 8 MiB: ${relative}`)
      entries.push({ name: relative, type: "file", data: await readFile(absolute) })
    }
  }
  await append("theme.json")
  await append("dist")
  for (const optional of ["LICENSE", "NOTICE", "preview.png"]) {
    try {
      await lstat(resolve(root, optional))
      await append(optional)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  return entries
}

function octal(header, offset, width, value) {
  const text = value.toString(8).padStart(width - 1, "0")
  requireThat(text.length < width, "Tar numeric field overflow")
  header.write(`${text}\0`, offset, width, "ascii")
}

function tarHeader(entry) {
  const header = Buffer.alloc(512)
  const name = entry.name
  if (Buffer.byteLength(name) <= 100) {
    header.write(name, 0, 100, "utf8")
  } else {
    const at = name.lastIndexOf("/", name.length - (name.endsWith("/") ? 2 : 1))
    const prefix = name.slice(0, at)
    const leaf = name.slice(at + 1)
    requireThat(at > 0 && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(leaf) <= 100, `Path exceeds portable ustar limits: ${name}`)
    header.write(leaf, 0, 100, "utf8")
    header.write(prefix, 345, 155, "utf8")
  }
  octal(header, 100, 8, entry.type === "directory" ? 0o755 : 0o644)
  octal(header, 108, 8, 0)
  octal(header, 116, 8, 0)
  octal(header, 124, 12, entry.data.length)
  octal(header, 136, 12, 0)
  header.fill(32, 148, 156)
  header[156] = entry.type === "directory" ? 53 : entry.type === "metadata" ? 103 : 48
  header.write("ustar\0", 257, 6, "ascii")
  header.write("00", 263, 2, "ascii")
  const checksum = header.reduce((sum, value) => sum + value, 0)
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
  return header
}

export function buildArchive(entries) {
  inspectEntries(entries)
  const blocks = []
  for (const entry of entries) {
    blocks.push(tarHeader(entry), entry.data)
    const padding = (512 - entry.data.length % 512) % 512
    if (padding) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  const stream = Buffer.concat(blocks)
  requireThat(stream.length < LIMITS.stream, "Tar stream exceeds hub v1.5.0's decompression budget")
  const archive = gzipSync(stream, { level: 9 })
  requireThat(archive.length <= LIMITS.compressed, "Compressed archive exceeds 32 MiB")
  return archive
}

function tarText(header, offset, length) {
  return header.subarray(offset, offset + length).toString("utf8").split("\0", 1)[0]
}

function tarNumber(header, offset, length) {
  const text = tarText(header, offset, length).trim()
  requireThat(/^[0-7]*$/.test(text), "Only portable octal tar numeric fields are accepted by this release checker")
  return text ? Number.parseInt(text, 8) : 0
}

export function inspectArchive(archive) {
  requireThat(archive.length <= LIMITS.compressed, "Compressed archive exceeds 32 MiB")
  requireThat(archive[0] === 0x1f && archive[1] === 0x8b, "Theme archive must be gzip, not zip or a source checkout")
  // gunzip validates the trailer CRC and has a hard output limit before allocating a bomb.
  const stream = gunzipSync(archive, { maxOutputLength: LIMITS.stream })
  requireThat(stream.length < LIMITS.stream, "Tar stream reaches hub v1.5.0's decompression budget")
  const entries = []
  let offset = 0
  let endFound = false
  while (offset + 512 <= stream.length) {
    const header = stream.subarray(offset, offset + 512)
    offset += 512
    if (header.every((byte) => byte === 0)) {
      endFound = true
      break
    }
    const checksum = tarNumber(header, 148, 8)
    const calculated = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0)
    requireThat(checksum === calculated, "Tar header checksum mismatch")
    const typeByte = header[156]
    const type = typeByte === 0 || typeByte === 48 ? "file" : typeByte === 53 ? "directory" : typeByte === 103 ? "metadata" : "unsupported"
    // Our generated release uses portable ustar. Reject extension formats rather
    // than partially interpreting a path/size override the hub would later read.
    requireThat(type !== "unsupported", `Unsupported tar entry type ${typeByte}; package this build with --pack`)
    const name = tarText(header, 0, 100)
    const prefix = tarText(header, 345, 155)
    const size = tarNumber(header, 124, 12)
    requireThat(size <= LIMITS.file, `File exceeds 8 MiB: ${name}`)
    requireThat(offset + size <= stream.length, "Tar payload is truncated")
    entries.push({ name: prefix ? `${prefix}/${name}` : name, type, data: stream.subarray(offset, offset + size) })
    requireThat(entries.length <= LIMITS.entries, `Archive has more than ${LIMITS.entries} entries`)
    offset += Math.ceil(size / 512) * 512
  }
  requireThat(endFound, "Tar end marker is missing")
  requireThat(stream.length - offset <= LIMITS.padding, "Data after tar end exceeds 1 MiB")
  requireThat(stream.subarray(offset).every((byte) => byte === 0), "Non-zero data hidden after tar end")
  return {
    ...inspectEntries(entries),
    compressedBytes: archive.length,
    tarStreamBytes: stream.length,
    sha256: digest(archive),
    limitBytes: LIMITS,
    format: "portable-ustar-gzip",
    policy: "Hub v1.5.0 limits plus stricter local release safety checks; not a sandbox for arbitrary third-party themes.",
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 2 && args[0] === "--archive") {
    const archive = resolve(args[1])
    const result = inspectArchive(await readFile(archive))
    console.log(JSON.stringify({ ok: true, archive, ...result }, null, 2))
    return
  }
  requireThat(args.length === 0 || (args.length === 1 && args[0] === "--pack"), "Usage: node scripts/check-package.mjs [--pack | --archive path]")
  const entries = await collect(ROOT)
  const archive = buildArchive(entries)
  let file
  if (args[0] === "--pack") {
    file = resolve(ROOT, "theme.tar.gz")
    await writeFile(file, archive)
    const readback = await readFile(file)
    requireThat(digest(readback) === digest(archive), "Written archive SHA-256 mismatch")
  }
  console.log(JSON.stringify({ ok: true, ...(file ? { archive: file } : {}), ...inspectArchive(archive) }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Theme package check failed: ${error.message}`)
    process.exitCode = 1
  })
}
