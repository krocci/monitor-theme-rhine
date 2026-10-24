# 公开演示站

演示地址：**https://rhine-observation-demo.yahad.workers.dev**

演示站使用 Cloudflare Workers Static Assets 托管主题，Worker 提供独立、只读的合成数据 API 和 WebSocket。无需部署 Monitor hub，也不需要真实节点、服务器地址或登录凭证。页面顶部始终标记为合成数据；管理入口打开演示说明，不提供登录表单。

## 演示内容

- 与主题共用同一份前端源码，保留节点简报、索引、详情、连续滚轮、关注和显示偏好。
- 六个合成节点覆盖在线、离线、待上报、未分组和长名称。
- 资源指标每两秒通过 WebSocket 更新，并支持主题现有的 HTTP 回退。
- 网络历史含七条线路、一天约 2.5 万个原始测量点、超时、真实缺测和尖峰。打开节点 101 的“网络探测”，选择“1 天”可查看密集场景。
- 节点 104 保留未上报历史的状态，节点 106 保留未配置探测任务的状态。

公开 API 没有本地模拟服务的 `/test` 控制器，也没有登录、配置写入或真实数据代理。历史请求限制为 1 至 168 小时。每条 WebSocket 最长十分钟，随后由主题现有逻辑重连；标签隐藏时沿用主题暂停连接的行为。

## 本地构建与检查

使用 Node.js **24.19.0** 和原 `package-lock.json`：

```sh
npm ci
npm test
npm run test:tooling
npm run lint
npm run build:demo
npm run dev:demo
```

打开 Wrangler 输出的本机地址，默认 `http://127.0.0.1:8787`。`dev:demo` 默认使用本地 Workers 运行时；项目没有远端存储绑定。

在另一个终端运行 `npm run check:demo -- http://127.0.0.1:8787`，可检查静态资源、详情直达、只读 API、一天密集历史和 WebSocket 连续推送。部署后将地址换为线上演示地址，可重复执行相同检查。

`build:demo` 输出 `demo-dist/`，只在该目录添加演示横幅、说明页和响应头。普通 `npm run build` 仍输出 `dist/`，安装包继续只读取 `dist/`。合成数据只打入独立的演示 Worker，不进入主题安装包。

## 部署到自己的 Cloudflare 账号

首次使用 Wrangler 时完成 Cloudflare 登录，然后部署：

```sh
npx --yes --package wrangler@4.152.0 wrangler login
npm run deploy:demo
```

Wrangler 固定使用 `4.152.0`，通过 npm 临时工具运行，不改变项目依赖或锁文件。配置位于 [`wrangler.demo.jsonc`](../wrangler.demo.jsonc)，默认 Worker 名为 `rhine-observation-demo`；部署到自己的账号会获得该账号下的 `workers.dev` 地址。名称冲突时先修改配置中的 `name`。

部署只需独立 Worker 与静态资源，不要求更改 DNS、Tunnel、Access 或现有 Monitor。仓库不保存 API Token、账号 ID 或登录凭证。

如使用 Cloudflare 控制台连接此 GitHub 仓库，构建命令填写 `npm ci && npm run build:demo`，部署命令填写 `npx --yes --package wrangler@4.152.0 wrangler deploy --config wrangler.demo.jsonc`，Node.js 版本固定为 `24.19.0`。Git 自动部署需要站点维护者另行连接仓库；提交配置本身不代表已启用自动部署。

## 验证边界

演示站的接口检查与实际浏览器操作分别记录，首轮结果见 [2026-10-24 演示站验收](DEMO-ACCEPTANCE.md)。HTTP 成功、WebSocket 收到数据、Node 数据处理基准均不能替代浏览器性能验收；真实触控板、手机与长时连接仍需在目标设备上另行验证。
