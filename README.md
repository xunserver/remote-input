# 远程输入

这是一个 pnpm workspace + Turborepo 管理的 monorepo。

## 当前状态

- V2 Web Bluetooth -> ESP32-S3 -> USB vendor HID -> desktop agent 链路已加入；设计、UUID、framing 与构建方式见 [V2 架构](docs/v2-ble-hid-architecture.md)。固件基线为 ESP-IDF 6.x。
- 不能运行桌面 agent 的电脑可使用 Chrome/Edge 打开 `/receive/`，通过 WebHID 接收并显示文字；协议核心位于 `packages/agent-sdk`。
- V1 WebSocket Transport、双向 Session Request/Response 和 SDK Client 已实现；Transport 支持 UTF-8 分片重组、逐 chunk ACK/重试和窗口发送。
- apps/client 与 apps/server 已迁移到原生 WebSocket `/ws` 接入，不再使用 Socket.IO 协议。
- Server 默认写入剪贴板并执行系统粘贴；只有显式设置 `INPUT_MODE=dev` 才仅打印收到的文字。
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
  agent-sdk/               HID Session 请求处理与 WebHID agent

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
pnpm --filter @remote-copy/web-agent dev
pnpm --filter @remote-copy/server start
```

Turborepo 负责任务编排和缓存：

```bash
pnpm check
pnpm build
INPUT_MODE=dev pnpm dev
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
INPUT_MODE=dev pnpm dev:server
pnpm dev:client
```

查看一条输入从 Session Pending、Transport 分片、窗口 ACK、服务端 Handler 到
Response 结算的开发日志：

```bash
INPUT_MODE=dev PROTOCOL_DEBUG=summary VITE_PROTOCOL_DEBUG=summary pnpm dev
```

需要逐个观察 chunk、重试和窗口补位时：

```bash
INPUT_MODE=dev PROTOCOL_DEBUG=chunks VITE_PROTOCOL_DEBUG=chunks pnpm dev
```

`chunks` 模式会使用从 1 开始的编号输出中文日志，例如：

```text
[协议][客户端/运行-1][传输层][chunk.send] 尝试发送 chunk 1/3：传输ID=1，第1次尝试
[协议][服务端/连接-1][传输层][chunk.received] 收到 chunk 1/3：传输ID=1，内容=65536B
[协议][服务端/连接-1][传输层][ack.send] 尝试发送 chunk 1/3 的 ACK：传输ID=1
[协议][客户端/运行-1][传输层][chunk.ack.received] 收到 chunk 1/3 的 ACK：传输ID=1，已确认=1/3
```

其中 `chunk.send` 和 `ack.send` 表示进入底层 `WebSocket.send()` 的发送尝试；
`chunk.ack.received` 才表示发送端确实收到了该 chunk 的 ACK。

`PROTOCOL_DEBUG` 控制 Server 终端，`VITE_PROTOCOL_DEBUG` 控制浏览器开发者控制台。
协议追踪日志只包含 generation、requestId、transferId、chunk 序号、字节数和状态，
不会打印 Session payload、输入正文或 Handler 返回数据。两项默认均为关闭。

默认端口：

- 后端：http://localhost:17888
- Vite：http://localhost:5173
- WebHID 接收页：http://localhost:5174（随服务端构建后为 `/receive/`）

Server 的输入模式由 `INPUT_MODE` 控制：

- `paste`：默认值；先写入系统剪贴板，再向当前前台窗口模拟粘贴。发送前请先把光标放到需要输入的位置。
- `dev`：调试模式，只把收到的文字打印到标准输出，不修改剪贴板，也不模拟粘贴按键。

## V1 安全边界

V1 协议没有实现认证、授权或 WebSocket Origin 校验，服务端默认监听
`0.0.0.0`。请只在可信网络中运行，或通过 `HOST=127.0.0.1`、防火墙及反向
代理限制访问；默认 `paste` 模式下，任何能连到 `/ws` 的客户端都可以请求本机执行粘贴。

浏览器会把最近 20 条输入（包括失败项）以明文保存到 `localStorage`。不要
发送密码、一次性验证码等敏感内容；共享设备使用后请在页面中清空历史。
`INPUT_MODE=dev` 会把输入明文写入 Server 标准输出，请同时留意终端和日志采集系统。
