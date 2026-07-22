# 远程输入

这是一个 pnpm workspace + Turborepo 管理的 monorepo。

## 当前状态

- V1 WebSocket Transport、双向 Session Request/Response 和 SDK Client 已实现。
- apps/client 与 apps/server 已迁移到原生 WebSocket `/ws` 接入，不再使用 Socket.IO 协议。
- [SDK Request/Response 协议 V1 设计](docs/sdk-protocol-v1.md) 是当前实现依据。
- V1 只实现 WebSocket Transport 和双向 Request/Response，不实现旧版 Socket.IO、通知订阅或心跳协议。

## V1 结构

```text
apps/
  client/                  Vite + Vue 3 + Tailwind v4 + shadcn-vue 前端应用
  server/                  Node.js + TypeScript 后端应用

packages/
  protocol/                Session、Transport 契约与 WebSocket Transport
  sdk/                     面向应用的 Client 和类型化方法

apps/client/dist/          client 的 Vite 构建输出
apps/server/dist/public/   随 server 构建产物打包的网页静态文件
apps/client/components.json shadcn-vue 配置，组件生成到 apps/client/src/shadcn
pnpm-workspace.yaml        pnpm workspace 配置
turbo.json                 Turborepo 任务编排配置
```

## V1 边界

- `apps/client`：只放浏览器 UI、Vue 状态、页面组件、shadcn-vue 组件。
- `apps/server`：只放 Node 后端、WebSocket 接入、HTTP 静态托管、系统剪贴板/粘贴操作。
- `packages/protocol`：定义 JSON 报文、错误、Session、Transport 契约和 WebSocket 实现。
- `packages/sdk`：提供 Client、sendText 等类型化封装，不承担 ACK、重试或连接管理。

## pnpm + Turborepo

pnpm 负责 workspace 包管理：

```bash
pnpm install
pnpm --filter @remote-copy/client dev
pnpm --filter @remote-copy/server start
```

Turborepo 负责任务编排和缓存：

```bash
pnpm check
pnpm build
pnpm dev
```

`apps/server` 将 client 声明为构建依赖。构建 server 时，Turborepo 会先构建 client，
再把网页静态资源复制到 `apps/server/dist/public`。因此 server 的 `dist` 目录包含
可直接托管的完整网页资源。

shadcn-vue CLI 应在 Client workspace 中执行，并使用项目的 pnpm runner：

```bash
cd apps/client
pnpm dlx shadcn-vue@latest info
pnpm dlx shadcn-vue@latest add @shadcn/button
```

## 常用命令

```bash
pnpm check
pnpm build
pnpm start
pnpm dev:server
pnpm dev:client
```

默认端口：

- 后端：http://localhost:17888
- Vite：http://localhost:5173

触发粘贴依赖当前机器的前台焦点窗口。发送前请先把光标放到需要输入的位置。

## V1 安全边界

V1 协议没有实现认证、授权或 WebSocket Origin 校验，服务端默认监听
`0.0.0.0`。请只在可信网络中运行，或通过 `HOST=127.0.0.1`、防火墙及反向
代理限制访问；任何能连到 `/ws` 的客户端都可以请求本机执行粘贴。

浏览器会把最近 20 条输入（包括失败项）以明文保存到 `localStorage`。不要
发送密码、一次性验证码等敏感内容；共享设备使用后请在页面中清空历史。
