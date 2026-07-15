# 仓库协作指南

## 项目概览

这是一个使用 pnpm workspace 和 Turborepo 管理的 TypeScript monorepo，用于从网页向远程下游提交输入操作。

当前链路：

```text
Browser Client -> RemoteInputClient -> ProtocolSession -> SocketIoClientTransport -> Server
```

当前 Server 同时提供网页静态资源，并作为统一协议的一个下游实现。未来可能增加 Browser 到 ESP32 的蓝牙 Transport，但当前不要实现或模拟蓝牙。

## 目录职责

```text
apps/client/       React 网页、UI 状态和用户配置
apps/server/       HTTP 静态托管、Socket.IO 协议对端和输入处理
packages/protocol/ definitions 定义各层，implementations 实现各层
packages/sdk/      轻量 RemoteInputClient、SDK 状态和订阅
public/            Client 生产构建输出，不要手动编辑
```

## 架构边界

必须保持以下分层：

```text
RemoteInputClient
  -> ProtocolSession
    -> MessageCodec
      -> MessageTransport
```

- `RemoteInputClient` 负责远程输入 API、operation 缓存和订阅。
- `ProtocolSession` 负责请求响应关联、通知、心跳、超时和请求处理器。
- `MessageCodec` 负责协议报文与 `Uint8Array` 的转换。
- `MessageTransport` 只负责可靠、有序、保留消息边界的双工传输。
- Socket.IO Client/Server Transport 不得解析业务 JSON。
- 未来 BluetoothTransport 必须在内部处理 GATT、MTU、分片、重组、ACK 和重试。
- Client UI 不得直接解析协议报文。

不要重新创建同时承担协议和传输职责的 Channel 抽象。

## 协议约束

`packages/protocol` 是统一应用协议的唯一事实源。

- 根入口和 `@remote-copy/protocol/definitions` 只能导出类型、常量和分层契约。
- `@remote-copy/protocol/implementations` 只能导出运行时校验、Codec、Session 和 Transport 实现。
- SDK/Server 必须从 definitions 使用契约，从 implementations 显式使用标准实现。

协议包含：

- `request`：包含 `requestId`、`method` 和 `body`；
- `response`：使用相同 `requestId` 关联一次请求；
- `notification`：单向主动推送，不依赖 requestId；
- `ping` / `pong`：Session 心跳，使用独立 heartbeatId。

当前方法：

- `session.open`
- `input.submit`
- `operation.get`

当前通知：

- `operation.status`
- `session.peers`

标识职责必须分开：

- 传输分片序号只属于 Transport；
- requestId 只关联一次 Request/Response；
- operationId 关联长期操作和状态通知；
- heartbeatId 只关联一次 Ping/Pong。

修改协议时必须同时更新 TypeScript 类型、运行时解析、SDK/Server 实现和测试。禁止使用 `JSON.parse(...) as ProtocolMessage` 绕过校验。

## 状态语义

公共 operation state 只使用：

- `accepted`
- `processing`
- `succeeded`
- `failed`

`stage` 表达下游专属阶段，例如 Server 的 `copying` 或未来 ESP32 的 `forwarding`。

`succeeded` 表示当前协议下游完成了自身职责，不得在公共 SDK 中解释为固定 Agent 已执行。

状态通知必须携带递增 `revision`。SDK 只接受比缓存更新的 revision。

## 编码约定

- 使用严格 TypeScript 和判别联合。
- 公共 API 变化时同步更新 `packages/sdk/src/index.ts` 和中文 README。
- 保持依赖方向，SDK 通过协议包提供的 Socket.IO Client Transport 连接。
- 保留工作区已有修改，不重写无关文件。
- `dist/`、`.turbo/` 和 `public/` 是生成产物。
- 代码注释只解释实现本身无法表达的约束。

## 常用命令

```bash
pnpm install
pnpm check
pnpm build
pnpm test:protocol
pnpm test:sdk
pnpm test:server
pnpm dev:server
pnpm dev:client
```

默认端口：

- Server：`17888`
- Vite：`5173`

## 验证要求

- 修改协议：测试请求、成功/失败响应、通知、Ping/Pong 和非法报文。
- 修改 ProtocolSession：测试关联 ID、超时、断线清理、通知和心跳。
- 修改 Transport：测试字节消息边界、连接状态和错误。
- 修改 operation：测试 revision 去重、本地读取、订阅和主动刷新。
- 跨 workspace 改动：运行三个 test 命令、`pnpm check` 和 `pnpm build`。

真实联调默认只测试 `session.open`。自动验证不得发送非空 `input.submit`，避免意外操作本机剪贴板和触发粘贴。
