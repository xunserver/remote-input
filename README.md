# 远程输入

这是一个 pnpm workspace + Turborepo 管理的 monorepo。

## 目录规划

```text
apps/
  client/                  Vite + React + Tailwind v4 + shadcn 前端应用
  server/                  Node.js + TypeScript 后端应用

packages/
  protocol/                协议消息、校验、Codec、Session 和 Socket.IO Transport
  sdk/                     面向应用的轻量 RemoteInputClient

public/                    client 构建输出目录，由 server 运行时托管
apps/client/components.json shadcn 配置，组件生成到 apps/client/src/shadcn
pnpm-workspace.yaml        pnpm workspace 配置
turbo.json                 Turborepo 任务编排配置
```

## 典型边界

- `apps/client`：只放浏览器 UI、React 状态、页面组件、shadcn 组件。
- `apps/server`：只放 Node 后端、Socket.IO 对端、HTTP 静态托管、系统剪贴板/粘贴操作。
- `packages/protocol`：`definitions` 定义各层契约，`implementations` 提供校验、Session、Codec 和 Socket.IO 双端实现。
- `packages/sdk`：提供轻量 `RemoteInputClient`、状态缓存和通知订阅。

当前只实现 Socket.IO Transport。上层协议使用 requestId 关联一次请求响应，使用 operationId 关联长期操作及状态通知，心跳使用独立 heartbeatId。

- [远程输入模块架构](docs/architecture.md)：目标分层、协议语义和 Socket.IO 双端边界。
- [协议包定义与实现](packages/protocol/README.md)：definitions 契约、标识符边界、导入入口和自定义实现要求。
- [协议与 SDK 重构计划](docs/implementation-plan.md)：实施步骤、测试范围和完成标准。
- [SDK 使用与协议说明](packages/sdk/README.md)：当前公共 API 和协议报文参考。

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

`turbo.json` 中 `build` 使用 `dependsOn: ["^build"]`，所以构建 app 前会先构建其依赖包，例如 `packages/protocol`。

shadcn CLI 应在 Client workspace 中执行，并固定使用 `npx shadcn@latest`：

```bash
cd apps/client
npx shadcn@latest info
npx shadcn@latest add button
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
