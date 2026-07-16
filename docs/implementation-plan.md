# Socket.IO 协议与 SDK 重构实施计划

状态：已实施并通过协议、SDK、Server 专项测试以及全仓 `check`、`build`。完成范围包含 Socket.IO Transport 的二进制分帧、Go-Back-N 窗口、累计 ACK、重传和重组，并以第 5 节命令和第 6 节标准作为持续验收依据。

## 1. 目标

按照[目标架构](architecture.md)完成以下结果：

1. 新增 `@remote-copy/protocol` workspace，成为协议唯一事实源。
2. 协议包导出消息类型、校验、Codec、Transport、Session 和 Socket.IO 双端适配器。
3. `@remote-copy/sdk` 只保留 `RemoteInputClient`、SDK 状态、错误和订阅 API。
4. Client 通过 SDK 直接连接 Socket.IO URL，不再构造 WebSocket Transport。
5. Server 使用 Socket.IO 和协议包的 `ProtocolSession` 实现对端。
6. 删除旧 `@remote-copy/shared`、手写 WebSocket frame/server 和 SDK 内重复协议实现。
7. 使用测试证明 request/response/notification/heartbeat、operation 和 Socket.IO 集成行为。

## 2. 兼容性决策

本次是内部 monorepo 的协议重构，允许一次性更新 Client、SDK 和 Server，不保留旧普通 WebSocket `/ws` 协议。

公共行为保留：

- `sendInput(text)` 返回 `{ operationId }`，表示下游已接受。
- operation 最终状态继续通过推送更新。
- `accepted | processing | succeeded | failed` 状态保持。
- operation revision 去重保持。
- 默认服务端口 `17888` 保持。

公共 API 调整：

```text
旧：client.connect(new WebSocketTransport("ws://host:17888/ws"))
新：client.connect("http://host:17888")
```

协议调整：

- `event` 更名为 `notification`。
- `id` 更名为 `requestId`，只用于 Request/Response。
- `input.submit` 增加发送端生成的 `operationId`。
- 增加独立 `ping` / `pong` 和 `heartbeatId`。
- Socket.IO 只使用 `protocol:frame` 事件承载 DATA 或 ACK 二进制帧。
- Codec 产出的完整字节消息由 Socket.IO Transport 拆分、可靠发送并重组；Session 与 Codec 只看到完整消息。
- Transport ACK 只确认字节帧交付，不替代协议 Response。

## 3. 实施步骤

### 步骤一：创建协议 workspace

新增：

```text
packages/protocol/package.json
packages/protocol/tsconfig.json
packages/protocol/src/definitions/messages.ts
packages/protocol/src/definitions/message-codec.ts
packages/protocol/src/definitions/message-transport.ts
packages/protocol/src/definitions/protocol-session.ts
packages/protocol/src/definitions/index.ts
packages/protocol/src/implementations/validation.ts
packages/protocol/src/implementations/json-message-codec.ts
packages/protocol/src/implementations/protocol-session.ts
packages/protocol/src/implementations/socket-io-frames.ts
packages/protocol/src/implementations/socket-io-fragment-controller.ts
packages/protocol/src/implementations/socket-io-client-transport.ts
packages/protocol/src/implementations/socket-io-server-transport.ts
packages/protocol/src/implementations/socket-io-shared.ts
packages/protocol/src/implementations/index.ts
packages/protocol/src/index.ts
```

要求：

- 严格 TypeScript 判别联合。
- 所有不可信输入运行时校验。
- method/result/notification map 提供端到端类型推导。
- `ProtocolSession` 不依赖 DOM、React、Node HTTP 或输入执行。
- Socket.IO Client Transport 是唯一需要浏览器 Socket.IO runtime 的协议模块。
- Server Transport 只依赖最小 socket 接口，Server 负责创建真正的 Socket.IO Server。
- 根入口和 `/definitions` 只导出定义，`/implementations` 只导出实现，禁止交叉混放。

### 步骤二：实现协议消息和校验

实现并测试：

- Request。
- 成功/失败 Response。
- Notification。
- Ping/Pong。
- `session.open`、`input.submit`、`operation.get` body/result。
- `operation.status`、`session.peers` notification body。
- 非法版本、ID、method、notification name 和 body。
- 最大协议消息与最大输入 UTF-8 字节限制。

### 步骤三：实现通用 ProtocolSession

实现：

- `connect()` / `disconnect()`。
- `request()` 和 requestId pending Map。
- 重复 requestId 拒绝。
- Response 成功 body 的 method-specific 校验。
- 请求超时和断线拒绝。
- `notify()`。
- notification 分发。
- `handleRequest()` 和自动成功/失败 Response。
- 未注册 handler 的标准错误。
- Ping 自动回复 Pong。
- 可选主动心跳、heartbeatId、Pong 匹配和超时断开。
- Session generation，防止旧连接消息进入新 Session。

### 步骤四：实现 Socket.IO Transport

Client：

- 使用 `socket.io-client`。
- `autoConnect: false`。
- `reconnection: false`。
- 通过唯一的 `protocol:frame` 事件收发二进制 DATA/ACK 帧。
- 连接超时、connect_error、disconnect 和错误状态。
- 隔离被替换 socket 的迟到事件。

Server：

- 包装已连接的 Socket.IO socket。
- 将 `protocol:frame` 标准化为 `Uint8Array` 并执行严格帧校验。
- 发送时复制字节。
- socket disconnect/error 转换为 Transport event。

Client 和 Server Transport 使用完全相同的帧协议。所有多字节整数使用大端（network byte order）。DATA 帧由固定 28-byte header 和 payload 组成：

```text
u16 magic = 0x5243
u8  frameVersion = 1
u8  kind = 1
u32 frameSeq // DATA 使用 0..0xfffffffe；0xffffffff 保留给最终累计 ACK
u32 messageId
u32 chunkIndex
u32 chunkCount
u32 totalMessageBytes
u32 payloadBytes
u8  payload[payloadBytes]
```

ACK 帧固定为 8 bytes：

```text
u16 magic = 0x5243
u8  frameVersion = 1
u8  kind = 2
u32 nextExpectedFrameSeq
```

可靠发送要求：

- 默认 DATA payload 上限 16 KiB、发送窗口 8 帧、ACK timeout 2 秒、最多重传 3 次；接收重组连续 10 秒无进展时按连接错误清理。
- 使用 Go-Back-N 和累计 ACK；ACK 的 `nextExpectedFrameSeq` 确认此前全部 DATA 帧。
- 每个新连接双向各自从 `frameSeq=0`、`nextExpectedFrameSeq=0` 和 `messageId=0` 开始连续递增；序号不在连接内回绕。
- ACK 绕过 DATA 窗口与完整消息队列，ACK 本身不再确认。
- 发送队列允许窗口跨越多个完整消息，但使用 `messageId` 与 chunk 元数据保持边界和顺序。
- `send()` 只有在对应完整消息的全部 DATA 帧被 Transport ACK 后才 resolve。
- 单条完整消息最多 256 KiB；队列中的在发及等待 ACK 消息最多 128 条且总计最多 4 MiB，任一上限超出都拒绝新发送。
- 接收端只接受连续 `frameSeq`，对重复或越序 DATA 丢弃 payload 并重发当前累计 ACK；只有完整重组并校验长度后才向 Session 发布消息。
- 双向分别维护独立序号、窗口和重组状态。断线、非法帧或重传耗尽必须清空队列、窗口、重组缓存和计时器，并拒绝未完成的 `send()`。
- Transport ACK 不使用 Socket.IO event ACK，也不改变 Request 必须等待协议 Response 的语义。

### 步骤五：精简 SDK

删除 SDK 内部：

```text
src/protocol/*
src/transports/*
```

`RemoteInputClient` 改为：

- `connect(url)` 内部创建 `SocketIoClientTransport`。
- 内部创建 `ProtocolSession` 并调用 `session.open`。
- `sendInput()` 先生成 operationId，再发送 `input.submit`。
- 继续缓存和订阅 operation。
- 新增 `subscribeNotification()`，向高级调用方透传已校验 Notification。
- 从协议包导入和重导出公共领域类型。

### 步骤六：迁移 Server

删除：

```text
apps/server/src/ws/frame.ts
apps/server/src/ws/webSocketServer.ts
```

新增 Socket.IO 协议对端：

```text
apps/server/src/socket-io/protocol-server.ts
```

实现：

- 创建 Socket.IO Server 并绑定现有 HTTP server。
- 每个连接创建 Transport 和 Session。
- 注册三个 method handler。
- `session.open` 之前拒绝其他业务 method。
- Server 按 Client 提供的 operationId 去重。
- InputQueue 通过 Session `notify()` 推送状态。
- peer 列表通过 Notification 广播。
- socket 断开清理会话，但 operation 状态保留策略有明确上限。

### 步骤七：迁移 Client

- 连接配置从 `ws://.../ws` 改为 Socket.IO HTTP(S) origin。
- 调用 `client.connect(url)`。
- 删除 `WebSocketTransport` 引用。
- 保持 UI 状态、历史和 operation 展示不变。

### 步骤八：移除旧 shared 包并更新文档

- 所有 `@remote-copy/shared` 依赖迁移到 `@remote-copy/protocol`。
- 删除 `packages/shared`。
- 更新根 tsconfig references/path、package scripts 和 lockfile。
- 重写 SDK README 为 Socket.IO API。
- 更新根 README 的目录、运行方式和架构链接。

## 4. 测试计划

### 4.1 协议解析测试

覆盖：

- 每类合法消息。
- 成功/失败 Response。
- 非法版本和 kind。
- Request/Notification 的 method/name 与 body 不匹配。
- operation revision、progress 和状态非法值。
- Ping/Pong 缺少或使用空 heartbeatId。
- 非法 UTF-8、JSON 和消息大小。

### 4.2 ProtocolSession 单元测试

使用内存 Transport 覆盖：

- requestId 关联。
- 两个并发 Request 逆序返回。
- 自定义重复 requestId 被拒绝而不覆盖旧 pending。
- Request 超时。
- disconnect 清理全部 pending。
- request handler 成功、抛出协议错误和未注册方法。
- notification 不产生 Response。
- Ping/Pong。
- 心跳超时断开。
- 旧 Session generation 消息被丢弃。

### 4.3 Socket.IO Transport 集成测试

启动临时 HTTP + Socket.IO Server：

- Client/Server Transport 建连。
- DATA 28-byte header 和 ACK 8-byte 帧的字段、长度、大端编码及非法值。
- 小消息和超过 16 KiB 消息的双向拆分、重组、消息边界和顺序。
- 8 帧窗口、跨消息填充窗口和 Go-Back-N 累计 ACK 推进。
- 重复/越序 DATA 的丢弃与累计 ACK 重发，ACK 绕过反向 DATA 窗口。
- ACK timeout 后重传、最多 3 次重传以及耗尽后的断开清理。
- `send()` 在完整消息全部帧确认前保持 pending，确认后完成。
- 256 KiB 单消息限制和 128 条/4 MiB 队列双重限制。
- 非法帧、disconnect 和旧 socket 迟到事件清理发送与重组状态。
- disconnect 状态。
- ProtocolSession 通过真实 Socket.IO 完成 `session.open`。

测试 handler 不调用真实剪贴板。

### 4.4 SDK 测试

- `connect(url)` 完成握手并进入 ready。
- `sendInput()` 提供发送端 operationId。
- 空文本、未连接、能力缺失和 busy。
- notification 原始订阅。
- operation revision 去重和主动刷新。
- disconnect 清理会话状态。
- 心跳或 Transport 错误映射。

### 4.5 Server 测试

- 未 `session.open` 时拒绝 `input.submit`。
- 重复 operationId 不重复执行。
- operation 只允许创建它的 Session 查询。
- 状态 notification revision 递增。
- peer notification 与连接数一致。

## 5. 验收命令

```bash
pnpm install
pnpm test:protocol
pnpm test:sdk
pnpm test:server
pnpm check
pnpm build
```

还需检查：

```bash
rg '@remote-copy/shared|WebSocketTransport|RemoteWebSocketServer|/ws' \
  apps packages README.md docs
```

结果中不得残留旧实现引用；架构文档中用于解释已移除方案的文字除外。

## 6. 完成标准

- `@remote-copy/protocol` 构建并完整导出分层接口。
- SDK 不再包含自有 Codec、Session 或 Transport 实现。
- SDK 普通调用方只传 Socket.IO URL。
- Server 不直接解析协议 JSON，不直接构造 request/response envelope。
- Request/Response 复用 requestId。
- Notification 不携带 requestId，也不触发 Response。
- 心跳由 Session 使用 Ping/Pong 管理。
- Socket.IO 只使用 `protocol:frame` 传输 DATA/ACK 二进制帧。
- Socket.IO Transport 对 Codec 完整消息执行 16 KiB 拆分、Go-Back-N 8 帧窗口、累计 ACK、2 秒超时和最多 3 次重传。
- 单条完整消息不超过 256 KiB，发送队列同时受 128 条和 4 MiB 限制。
- `send()` 等到完整消息的全部帧被 Transport ACK；断线和非法帧正确清理全部未完成状态。
- Session 与 Codec 只收到重组后的完整消息，Transport ACK 不替代协议 Response。
- operationId 由发送端创建，Server 重复 ID 不重复执行。
- Client、SDK、Server 使用同一协议版本和运行时校验。
- 协议、SDK、Socket.IO 集成测试通过。
- `pnpm check` 和 `pnpm build` 通过。
