# Session + Socket.IO Transport Brownfield 提取

## 1. 提取边界

本报告只陈述当前仓库中已经存在、已文档化或可由测试证明的事实，并标出会影响下一版 PRD 的缺口与兼容面。它不替代 PRD，也不把技术机制直接升级为产品需求。

术语分类：

- **需求语义（What）**：调用方可依赖的能力、完成条件、失败与资源边界。
- **当前技术机制（How）**：当前标准实现满足需求所使用的 JSON、Socket.IO、帧、窗口、ACK、Map 和计时器。
- **缺口**：现有实现/测试未形成稳定契约，或文档与代码存在差异，PRD 必须决定是否纳入。

主要证据：`AGENTS.md`、`docs/architecture.md`、`docs/implementation-plan.md`、`packages/protocol/README.md`、`packages/protocol/src/definitions`、`packages/protocol/src/implementations`、`packages/protocol/tests`，以及现有 SDK/Server 调用点。

## 2. 现有调用方与集成关系

| 调用方 | 当前使用方式 | 对 PRD 的约束 |
| --- | --- | --- |
| `RemoteInputClient` | 创建或异步取得 `MessageTransport`，默认创建 `SocketIoClientTransport(url)`；创建 `ProtocolSession`，先订阅 Session，再 `connect()`，随后请求 `session.open` 并启动心跳；通过 `request()` 调用 `input.submit` / `operation.get`；disconnect 时释放 Session。见 `packages/sdk/src/remote-input-client.ts:94-145,157-237`。 | Session/Transport 的公共变化会直接改变 SDK 的连接状态、错误映射、operation 提交和恢复行为。普通 Browser UI 不直接接触协议。 |
| Socket.IO Server | 每个 socket 创建一个 `SocketIoServerTransport` 和一个 `ProtocolSession`；注册 `session.open`、`input.submit`、`operation.get` handler；使用 `notify()` 推送 `operation.status` 和 `session.peers`；监听 Transport state 清理 client。见 `apps/server/src/socket-io/protocol-server.ts:53-160`。 | Session 必须同时支持主动 Request 方和被动 handler 方；Server Transport 必须包装已接入的单 socket。 |
| Server/SDK 集成测试 | Server 测试直接组合 `ProtocolSession + SocketIoClientTransport`；SDK 测试用自定义内存 `MessageTransport` 作为替身。 | `MessageTransport` 方法、事件和 Session 生命周期是跨 workspace 测试契约，不是仅 protocol 包内部细节。 |
| 自定义 Transport 使用者 | README 允许调用方仅实现 definitions 中的 `MessageTransport`，并由 SDK 的 `createTransport` 工厂同步或异步注入。 | Transport 接口重命名、事件收紧或状态变化属于公开兼容变更，必须同步示例、类型、SDK factory 和测试替身。 |

当前依赖链固定为：

```text
RemoteInputClient -> ProtocolSession -> MessageCodec -> MessageTransport
```

不得重新引入同时承担协议和传输职责的 Channel；Transport 不解析业务 JSON，UI 不解析协议报文（`AGENTS.md:25-51`）。

## 3. 需求语义（PRD 可表达的 What）

### Session 能力

- 支持类型安全的 Request/Response，并用 requestId 将并发请求与唯一 Response 关联。
- 支持无需 Response 的 Notification，以及可注册的 typed Request handler。
- 支持独立 heartbeatId 的 Ping/Pong；主动心跳需显式启动，Transport connect 不等于 `session.open` 或 ready。
- Request/Ping 必须在发送前登记关联状态，以接受早于本地 Transport ACK 的 Response/Pong。
- Response/Pong timeout 从完整消息被 Transport 确认交付后开始；发送排队和链路重传时间不消耗上层响应 timeout。
- reconnect/disconnect 必须隔离 generation，拒绝 pending request、停止心跳，并阻止旧异步 handler 向新连接发送 Response。
- 成功 Response body 必须按原始 method 执行运行时校验；远端结构化失败以 `ProtocolResponseError` 暴露。

### Transport 能力

- 对 Session 提供可靠、有序、保留消息边界、至多一次向上交付的双工完整字节消息通道。
- `send(message)` 的完成条件是对端 Transport 已确认完整消息；它不表示对端 Session 已解析，也不表示 Request 或长期 operation 已完成。
- 必须报告连接状态、完整消息和错误；断线或 connection-fatal 失败必须拒绝所有未完成 send 并释放队列、重组和计时器资源。
- 必须有界：单消息、队列条数、队列字节、窗口、重传和重组存活时间均受限制。
- ACK/重传等链路行为不得泄漏为 Session requestId、operationId 或业务方法语义。

### 跨层安全与信任边界

- `@remote-copy/protocol` 是应用协议唯一事实源；definitions 只公开类型、常量和契约，implementations 显式公开运行时实现。
- Codec 把字节视为不可信输入，执行 UTF-8、JSON、版本、envelope、body/result 和大小校验；禁止 `JSON.parse(...) as ProtocolMessage`。
- requestId、operationId、heartbeatId、messageId/frameSeq 的职责与生命周期不得混用。

## 4. 当前公开契约

### `MessageTransport`

当前 definitions（`packages/protocol/src/definitions/message-transport.ts:1-39`）：

```ts
type TransportState = "idle" | "connecting" | "connected" | "disconnected" | "error";

type TransportEvent =
  | { type: "state"; state: TransportState }
  | { type: "message"; message: Uint8Array }
  | { type: "error"; error: unknown };

interface MessageTransport {
  readonly kind: string;
  readonly state: TransportState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: Uint8Array): Promise<void>;
  subscribe(listener: TransportListener): () => void;
}
```

兼容事实：当前方法名是 `subscribe`，不是 `receive`；error 为 `unknown`，没有公开 code/fatal 分类；取消订阅依赖 `Set.delete`，实际可重复调用。

### `ProtocolSessionContract`

当前 definitions（`packages/protocol/src/definitions/protocol-session.ts:13-92`）公开：

- `readonly transport`；
- `connect()` / `disconnect()`；
- generic `request(method, body)`；
- generic `notify(name, body)`；
- `handleRequest(method, handler)`；
- `subscribe(listener)`；
- `startHeartbeat()` / `stopHeartbeat()`。

`ProtocolSessionOptions` 当前允许替换 Codec、request/heartbeat ID factory、request timeout、pending 上限、heartbeat interval/timeout。默认实现使用 request timeout `10s`、pending `128`、heartbeat interval `15s`、heartbeat timeout `10s`（`protocol-session.ts:85-96`）。

### 包导出

- 根入口和 `/definitions` 只重导出 definitions；不得出现 `ProtocolSession`、`JsonMessageCodec` 或 Socket.IO concrete Transport。
- `/implementations` 导出标准 ID、Codec、Session、Socket.IO Transport、验证器和 Transport 默认选项；私有 fragment controller 不导出。
- `packages/protocol/tests/exports.test.mjs` 已把这项边界固化为测试。

## 5. 当前技术机制（实现 How，不应直接伪装成产品 FR）

### Session 机制

- `Map<requestId, PendingRequest>` 保存 method、resolve/reject 和延迟启动的 timer；只拒绝与“当前 pending”重复的 ID。
- Session 在 `transport.send()` 前写入 pending；send resolve 后才启动 Response timeout。早到 Response 会先删除 entry，后续 send resolve/reject 不再反转结果。
- `connect()` 递增 generation、停止心跳、拒绝旧 pending、替换 Transport 订阅；旧 generation message 和异步 handler Response 被抑制。
- handler 未注册返回 `method.unsupported`；`ProtocolRequestError` 转成远端结构化错误，其他异常转成 `request.failed`。
- Ping 接收方立即回 Pong；主动方同一时刻只等待一个 Pong，timeout 后拒绝 pending 并 disconnect Transport。
- Session listener 异常不会停止其他 listener；非 error 事件上的 listener 异常会再作为 Session error event 报告。

### Socket.IO Transport 机制

- Client 使用 `socket.io-client`，`autoConnect:false`、`forceNew:true`、`reconnection:false`；默认 connect timeout `10s`。后一次 Client `connect()` 会取消并替换正在进行的 connect。
- Server Transport 包装一个已由 Socket.IO 接受的 socket；同一 socket 上重复 `connect()` 当前是幂等的。
- 双端只使用 `protocol:frame`。DATA 为 28-byte 大端 header + payload，ACK 固定 8 bytes。
- 私有 `SocketIoFragmentController` 使用 Go-Back-N、累计 ACK 和跨消息窗口；ACK 同步绕过 DATA 队列，连续 DATA 先推进状态并 ACK，再向上交付完整消息。
- 默认：16 KiB payload、8 DATA 窗口、2s ACK timeout、初发之外最多 3 轮重传、10s 重组无进展 timeout、256 KiB 单消息、128 条/4 MiB 队列。
- 除 ACK/connect timeout 外，公开选项只能调低硬上限；两端若调低 chunk 必须自行配置一致，wire 不协商 chunk 大小。
- send 时复制调用方字节；接收入站 packet 先检查编码长度，再解析并复制合法 payload。

上述 wire、Go-Back-N 和具体默认值是当前标准 Socket.IO 实现机制。PRD 可要求可靠性、顺序、边界、资源上限和完成语义；若必须锁定跨版本互操作，再把 wire 格式与数值列为兼容性 NFR/约束，而不是普通产品功能。

## 6. Brownfield 缺口与待决项

| 缺口 | 当前事实 | 对范围/验收/兼容的影响 |
| --- | --- | --- |
| Transport 上行命名 | 公共接口、README、Session 和全部测试替身均使用 `subscribe(listener)`；`receive` 仅是 fragment controller 的私有入帧方法。 | 若 PRD 要求公开 `receive(listener)`，这是跨 protocol/SDK/Server/tests/README 的 breaking rename，不能描述成现状。 |
| 错误结构不稳定 | `TransportEvent.error` 和 `ProtocolSessionEvent.error` 都是 `unknown`；实现主要抛普通 `Error` 并依赖 message 文本。 | 若验收需要稳定 code、fatal 分类或 cause，必须新增公共错误契约及逐来源映射测试。 |
| ID 去重仅覆盖当前 pending | outbound requestId 完成后可复用；inbound 重复 requestId 会再次执行 handler；heartbeatId 也没有 generation 内 seen set。 | 若 PRD 需要 generation 内永不复用或防止重复 handler 副作用，属于新增 Session 行为和资源策略。 |
| Client/Server fatal 终态可分叉 | Client fatal 在本地保留 `error`；Server fatal 先发 `error`，随后 socket disconnect handler 可改为 `disconnected`。 | 若调用方依赖统一 terminal state/event 顺序，需要新增双端一致性要求和测试。 |
| connect 并发语义不统一 | Client Transport 的后 connect 取消前 connect；Server Transport 已 connected 时幂等；Session reconnect 会替换 generation。 | PRD 应分别定义 Session、Client Transport、Server Transport 的幂等/替换语义，不能只写“connect 幂等”。 |
| Session 选项缺少运行时约束 | `maxPendingRequests`、request/heartbeat timeout 等由构造器直接接受；可以高于定义常量、为负数或超出宿主 timer 精确范围。 | 若资源上限是 NFR，需明确硬上限和非法配置验收；当前 Transport options 的校验不能代表 Session options 已校验。 |
| 测试边界仍有空白 | 当前没有显式覆盖零字节完整消息、frame/message 序号耗尽、已完成 requestId 复用、重复 inbound request、非法 Session options、双端 fatal 最终状态一致性。 | 这些若进入新 PRD 的完成标准，必须新增测试；不能引用当前 suite 声称已覆盖。 |
| chunk 配置不协商 | 当前 wire 不携带 chunk size，Client/Server 配置不一致会被当作非法 frame。 | 保持现状时应列为部署兼容约束；若要求自动互操作，属于新协议能力。 |

## 7. 非目标与范围护栏

- 当前不实现或模拟 Bluetooth/GATT/MTU；未来 Transport 仍需在自身内部满足完整消息契约。
- 不恢复旧普通 WebSocket `/ws`、`WebSocketTransport`、手写 WebSocket server 或已删除 shared 协议实现。
- 不设计通用不可靠传输协议，不新增 Channel 抽象。
- Transport 不解析 ProtocolMessage/业务 JSON；Session 不执行输入、不依赖 React、DOM、Node HTTP 或剪贴板。
- Socket.IO event ACK 不作为 Transport ACK；Engine.IO 心跳不替代协议 Ping/Pong。
- 当前关闭 Socket.IO 自动重连；重连由 SDK 显式创建新 Session。自动退避、resume 和跨连接 pending 恢复不是现有能力。
- TLS、Origin、认证、授权、速率限制属于公开部署安全议题，但不是当前 Session/Transport 已实现能力。
- 测试不得触发真实剪贴板/粘贴；真实联调默认只验证 `session.open`。

## 8. 兼容面

任何 Session/Socket.IO Transport PRD 变更至少需要逐项判断：

1. **TypeScript source compatibility**：`MessageTransport`、Transport state/event、`ProtocolSessionContract`、options、listener/unsubscribe、错误类。
2. **Package export compatibility**：根/definitions/implementations 边界和私有 controller 不泄漏。
3. **Wire compatibility**：`protocol:frame`、magic/version/kind、28/8-byte 格式、大端、序号与 ACK 语义、chunk 配对限制。
4. **Behavior compatibility**：send 完成时机、Response timeout 起点、early Response/Pong、generation、connect/disconnect/fatal event 顺序。
5. **Caller compatibility**：SDK 默认组合与自定义 Transport factory、Server 每 socket Session、MemoryTransport 测试替身、中文 README 示例。
6. **Operation safety**：Transport ACK 不得被 SDK/Server误解为 `input.submit` 已响应或 operation 已完成。

公共变化必须同步更新 definitions、implementations、SDK/Server 调用方、`packages/sdk/src/index.ts`（若 SDK 暴露面受影响）、三份中文 README 和相关测试。

## 9. 验证基线

### 当前已有证明

- Codec：五类 envelope round trip；非法版本/ID/name/body/progress；非法 JSON 和消息大小；definitions/implementations 导出隔离。
- Session：并发逆序 Response、当前 pending 重复 ID、timeout、早到 Response、延迟 send 后计时、远端错误、Notification、Ping/Pong、心跳失败、generation 隔离、旧异步 handler、reconnect cleanup、disconnect 失败时取消订阅。
- Transport：拆分重组、固定 wire/大端、窗口、跨消息、Go-Back-N、丢 DATA/ACK、至多一次交付、双向小窗口、重传耗尽、断线、connect 取消/超时/替换、Server connect 幂等、资源硬上限、重组 timeout、非法/矛盾 frame、buffer snapshot，以及真实 Socket.IO + ProtocolSession。

### 变更后的最低命令门槛

```bash
pnpm test:protocol
pnpm test:sdk
pnpm test:server
pnpm check
pnpm build
```

涉及本报告缺口的新要求时，必须在现有 suite 之外补对应测试。自动验证不得向真实 Server 发送非空 `input.submit`。

## 10. PRD 与技术附录分界建议

| 应进入 PRD 主体 | 应留在技术 addendum / architecture |
| --- | --- |
| 调用方、可靠/有序/边界语义、完成条件、超时起点、连接与错误可观察行为、资源上限、兼容与验收、非目标 | Go-Back-N 算法细节、Map/Set 数据结构、timer 安排、私有 controller 拆分、Socket.IO factory 注入、具体 frame 编解码过程 |
| 若必须保持互操作：wire version、不可破坏字段和升级策略 | 28-byte 字段 offset 表、ACK pump/retransmit 伪代码、内部缓冲复制实现 |

若 PRD 决定保留现有 wire 作为稳定兼容承诺，相关格式和默认上限可作为约束/NFR 引用；否则它们应被视为当前实现基线，而不是不可变产品需求。
