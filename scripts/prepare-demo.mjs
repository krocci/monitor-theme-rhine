import { copyFile, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const output = new URL("../demo-dist/", import.meta.url)
const index = new URL("index.html", output)
const repository = "https://github.com/krocci/monitor-theme-rhine"
const banner = `<aside class="rhine-demo-banner" aria-label="演示站说明">
  <div><strong>PUBLIC DEMO</strong><span>全部节点与曲线均为合成数据</span></div>
  <nav aria-label="演示站链接"><a href="${repository}">GitHub 源码</a><a href="${repository}/releases">下载主题</a></nav>
</aside>`
let html = await readFile(index, "utf8")
if (!html.includes('<div id="root"></div>') || html.includes("rhine-demo-banner")) {
  throw new Error("Build the theme into demo-dist before preparing the demo.")
}
html = html.replace("<title>Monitor</title>", "<title>Rhine Observation · 演示站</title>")
  .replace("</head>", '  <meta name="description" content="Rhine Observation 的公开演示：体验 Monitor 纸色二维主题、节点索引与历史曲线。全部使用合成数据。" />\n    <link rel="stylesheet" href="/demo.css" />\n  </head>')
  .replace('<div id="root"></div>', `${banner}\n    <div id="root"></div>`)
await writeFile(index, html)
await copyFile(new URL("demo.css", import.meta.url), new URL("demo.css", output))
await writeFile(new URL("demo-admin.html", output), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><link rel="stylesheet" href="/demo.css"><link rel="icon" href="/favicon.svg">
<title>演示站说明 · Rhine Observation</title></head>
<body class="rhine-demo-admin"><main><p>RHINE OBSERVATION / PUBLIC DEMO</p><h1>这里是主题演示站</h1>
<p>本站使用合成节点、资源指标和网络历史，展示主题的实际界面与交互。数据不对应真实服务器。</p>
<p>演示站不提供管理后台、登录或服务器操作。安装到自己的 Monitor 后，管理入口仍使用 Monitor 原生后台。</p>
<nav aria-label="演示导航"><a href="/">返回演示</a><a href="${repository}">查看源码与安装说明</a></nav>
</main></body></html>
`)
await writeFile(new URL("_headers", output), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
`)
console.log(`Prepared synthetic demo in ${fileURLToPath(output)}`)
