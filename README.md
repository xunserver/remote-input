# 远程输入

这是一个 pnpm workspace + Turborepo 管理的 monorepo。

## 目录规划

```text
apps/
  client/                  Vite + React + Tailwind v4 + shadcn 前端应用
  server/                  Node.js + TypeScript 后端应用

packages/
  sdk/                     SDK、协议会话、Codec 和 Transport
  shared/                  统一协议类型、方法/事件载荷和运行时校验

public/                    client 构建输出目录，由 server 运行时托管
components.json            shadcn 配置，指向 apps/client
pnpm-workspace.yaml        pnpm workspace 配置
turbo.json                 Turborepo 任务编排配置
```

## 典型边界

- `apps/client`：只放浏览器 UI、React 状态、页面组件、shadcn 组件。
- `apps/server`：只放 Node 后端、WebSocket、HTTP 静态托管、系统剪贴板/粘贴操作。
- `packages/sdk`：提供 `RemoteInputClient`、`ProtocolSession`、Codec、`DuplexTransport` 和 WebSocket Transport。
- `packages/shared`：定义统一的 Request/Response/Event 协议及运行时校验，不依赖具体传输方式。

当前 WebSocket 只是可靠双工传输器。上层协议使用 requestId 关联一次请求响应，使用 operationId 关联长期操作及状态事件。详细设计见 `packages/sdk/README.md`。

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

`turbo.json` 中 `build` 使用 `dependsOn: ["^build"]`，所以构建 app 前会先构建其依赖包，例如 `packages/shared`。

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
