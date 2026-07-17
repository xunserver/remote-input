# Brownfield Update Extract: Client / Session / Transport 最新架构对照

## 1. 提取范围与结论

本报告比较以下内容：

- 用户在当前讨论中最新确认的 Client、Session、Transport 职责；
- `AGENTS.md`；
- `docs/architecture.md`、`docs/implementation-plan.md`；
- 已标记 final 的 Architecture Spine；
- `packages/protocol`、`packages/sdk`、`apps/server` 的当前代码、公开导出和测试。

结论：现有实现已经具备可复用的协议消息、Codec、Request/Response 关联和较完整的 Socket.IO 可靠传输机制。下一版不是从零重写可靠传输，而是一次**公共生命周期契约、组合方式和发布边界的破坏性迁移**。最大的技术决策不是“是否支持重连”，而是必须明确：**跨一个新 Socket connection generation 是否允许继续同一条未完成 `send()`**。若不引入跨连接恢复/去重协议，安全默认只能是旧 generation 的未完成发送全部失败，Transport 自动重连只恢复后续发送能力。

## 2. 最新确认的目标模型

以下是本轮讨论中应优先于旧文档的目标语义。

### 2.1 消费与组合

```text
Browser application
  -> installs SDK + one chosen Client Transport package
  -> creates configured Transport instance
  -> new Client({ transport })
  -> Client.connect() / Client.inputText() / notification subscription

Server application
  -> installs Session + one chosen Server Transport package
  -> creates one accepted-socket Transport and one Session per peer connection
  -> does not depend on SDK
```

- SDK 是应用层，导出面向网页调用者的 Client。
- Browser 调用者直接创建 Transport，再把已创建的 Transport 传给 Client；SDK 不选择 Socket.IO，也不创建具体 Transport。
- Session 和 Transport 是 Browser/Server 都可组合的独立能力与发布边界。
- 当前只交付 Socket.IO Transport；WebSocket 和 Bluetooth 只是未来可插拔方向，当前不实现或模拟。

### 2.2 Session 数据职责

- Session 接收通用 method/body 调用，组装协议 Request，生成 `requestId`，并在 pending Map 中关联 Response。
- Session 拥有 Request Response timeout；该 timeout 与 Transport 的帧 ACK/重试失败是两类不同失败。
- Session 处理 Notification、入站 Request/Response、运行时解码和匹配；不理解 Socket.IO、chunk、window 或重连算法。
- 多个上层调用可以并发。Request A 的 `transport.send()` 尚未完成时，Request B 仍应立即提交给 Transport；Session 不建立第二套发送队列。
- Session 面向 Transport 的数据能力只有完整消息级 `send(message)` 和 `receive(listener)`。
- Session 不读 `transport.state`，不监听 Transport 连接状态，也不因 disconnected 事件立即清空 pending；已经发送的 Request 继续等待匹配 Response 或 Session Response timeout。
- 当前调用的 `transport.send()` reject 时，Session 只让该 Request 失败并移除其 pending；失败原因向 Client 传播。

### 2.3 Transport 数据与生命周期职责

- Transport 对 Session 呈现可靠、有序、保留消息边界的双工完整字节消息通道。
- Transport 自己负责 connect、意外断线后的 reconnect、完整消息队列、拆包/重组、窗口、累计 ACK、chunk 重传和交付失败。
- Transport 可以让窗口跨越多条完整消息，但不能改变消息边界和有序交付语义。
- `send(message)` 的 Promise 独立代表该完整消息的 Transport 交付结果；成功不是协议 Response，更不是业务完成。
- 一旦 `send()` reject，Transport 必须终止该条消息，以后绝不能再次发送它。
- Client 可以从 Transport 的生命周期表面读取 `state` 或订阅 `on(...)` 事件，用于连接 UI、首次连接、显式断开和重连后的应用握手；这条生命周期路径不能绕过 Session 发送协议消息。
- Session 只拿到数据端口；即使同一个对象还实现生命周期能力，Session 也不得依赖它们。

## 3. 当前已经具备、应尽量保留的能力

| 能力 | 当前证据 | 与目标关系 |
| --- | --- | --- |
| 协议唯一事实源 | `packages/protocol/src/definitions/messages.ts`、Codec、validation；根入口只重导出 definitions | 可保留；拆包后仍需一个无运行时耦合的共享 definitions 包/入口 |
| definitions / implementations 导出隔离 | `packages/protocol/package.json` 三个 exports；`packages/protocol/tests/exports.test.mjs` | 原则可保留，但 implementations 需要按独立发布边界搬迁 |
| 并发 Request/Response 关联 | `ProtocolSession` 先登记 pending，再调用 `send()`；Response 按 requestId 匹配 | 与目标一致，是 Session 主体 |
| Response timeout 与 Transport delivery 分离 | timer 只在 `send()` resolve 后启动；支持 Response 早于本地 send completion | 与最新澄清一致，应保留并写入验收 |
| 单条 send 失败只终结对应 pending | `rejectPendingRequest()` 按 requestId 删除和 reject | 与目标一致；需去掉 disconnected 时批量 reject Session pending 的旧路径 |
| Notification 和 typed Request handler | `notify()`、`handleRequest()`、runtime result validation | 可保留 |
| Codec 不可信边界 | `JsonMessageCodec` + validation，未使用 `JSON.parse(...) as ProtocolMessage` 绕过校验 | 可保留 |
| Socket.IO 完整消息传输 | 单一 `protocol:frame`，DATA/ACK wire、拆分、重组和双向顺序 | 可保留，属于 Socket.IO Transport 内部 |
| 跨消息窗口 | `SocketIoFragmentController` 的 frame 队列允许窗口进入下一条消息 | 已满足“Session 立即交给 Transport、Transport 排队”的核心场景 |
| ACK、Go-Back-N 和失败清理 | 累计 ACK、丢 DATA/ACK 恢复、重传耗尽、非法帧和重组超时 | 主体可保留；需接入重连策略和结构化错误 |
| 有界资源 | 256 KiB/message、128 queued messages、4 MiB queued bytes 等硬上限 | 可保留；容量拒绝仍应是当前调用失败 |
| 发送失败后不再偷偷发送 | controller close 会 reject 并清空 outbound messages/frames | 当前单 connection generation 内成立 |
| 同一 Client Transport 对象可创建新 Socket generation | `SocketIoClientTransport.connect()` 每次创建新 Socket；`lifecycleGeneration` 忽略旧事件 | 是实现同实例 reconnect 的基础，不必强制每次 `new Transport` |
| Server 每 socket 组合 Transport + Session | `apps/server/src/socket-io/protocol-server.ts` | 符合被动端拓扑；组合调用需要迁移 |
| SDK operation/cache/subscription 能力 | `RemoteInputClient` 的 operation revision、state、notification API | 可保留在 SDK 应用层，不应下沉到 Session/Transport |

### 当前测试基线

在 Protocol 先构建后，当前专项测试基线为：

- Protocol：69 passed；
- SDK：3 passed；
- Server：1 passed。

直接并行从无 Protocol `dist` 的状态执行三个 package test 会让 SDK/Server 编译先失败；Protocol build 完成后复跑均通过。这不是产品行为失败，但说明跨 workspace 验证应通过依赖有序的根 build/Turbo，或者让 package test 自己显式构建依赖。

## 4. 必须迁移的冲突

### 4.1 发布与依赖图冲突

当前：

- `@remote-copy/protocol` 是一个 `private: true` workspace，同时包含 definitions、Codec、Session 和 Socket.IO Client/Server Transport implementations。
- `@remote-copy/sdk` 也是 `private: true`，直接从 protocol implementations 导入并默认创建 `SocketIoClientTransport`。
- Browser app 只依赖 SDK，Socket.IO Client 通过 protocol 的传递依赖进入应用。

目标：

- Browser 显式安装 SDK 和一个具体 Client Transport；SDK 不依赖具体 Transport implementation。
- Server 显式安装 Session 和一个具体 Server Transport，不依赖 SDK。
- Session 与各 Transport implementation 可独立发布、独立版本化。

因此必须迁移 workspace/package 布局、package names、`private`、dependencies/peerDependencies、exports 和 lockfile。单纯保留 `@remote-copy/protocol/implementations` 子路径不能满足“Browser 安装 SDK + Transport、Server 安装 Session + Transport”的独立发布语义。

### 4.2 SDK 组合方式冲突

当前 `RemoteInputClient`：

```ts
new RemoteInputClient({ createTransport? })
await client.connect(url)
```

- `connect(url)` 创建/取得新 Transport，再创建新 Session；
- SDK 默认依赖 Socket.IO Transport；
- 后一次 connect 用 Client generation 淘汰旧 Transport/Session；
- README 明确关闭自动重连，要求应用再次 `connect(url)`。

目标调用改为调用者先创建 Transport，再直接注入 Client。SDK 必须移除默认 Socket.IO 选择和 `createTransport(url)` 主路径，Client 直接持有注入的 Transport，并从 Transport 生命周期事件维护应用 ready/连接视图。

### 4.3 Session 生命周期冲突

当前 `ProtocolSessionContract` 公开 `connect()` / `disconnect()`，实现还会：

- 调用 `transport.connect()` / `transport.disconnect()`；
- 在发送 Request 和 heartbeat 前读取 `transport.state`；
- 监听 state/error/message 联合事件；
- 转发 `transport-state` Session event；
- Transport disconnected/error 时立即停止心跳并 reject 所有 Session pending；
- heartbeat timeout 时主动断开 Transport；
- 每次 Session connect 建立/替换 Session generation。

最新目标要求 Session 对 Transport 连接状态与重连完全无感。因此以上所有生命周期耦合都必须移出 Session。Session 仍需要一个明确的自身资源释放能力，用于取消 receive listener、停止 Response/heartbeat timers、拒绝或释放 pending 和阻止已 dispose handler 回写；这不是 Transport disconnect 状态，但当前目标尚未给这个 API 命名。

### 4.4 Transport 接口冲突

当前 `MessageTransport` 是一个合并接口：

```ts
state + connect + disconnect + send + subscribe(state | message | error)
```

目标需要两个消费面：

```text
Session data port: send + receive(complete message)
Client lifecycle port: connect + disconnect + state + lifecycle events
```

是否通过两个 TypeScript interface、一个 interface 的结构化窄化，或其他命名实现属于 Architecture；但公共契约必须保证 Session 只能依赖数据面。现有 `subscribe` 事件联合也不满足“Session receive 只收到完整消息”，必须拆分或改名。

### 4.5 Socket.IO Client 重连冲突

当前 Client Transport 显式设置 `reconnection: false`，意外 disconnect 后：

- 关闭 fragment controller；
- reject 所有未完成 send；
- 进入 disconnected；
- 后续 send 立即报 not connected；
- 只有外部再次调用 `connect()` 才创建新 Socket。

目标把重连策略放进 Transport。现有 `lifecycleGeneration` 和“每次 connect 创建新 Socket/controller”可以复用，但必须新增：触发策略、共享 in-flight reconnect、退避/次数/总时限、显式 disconnect 取消、重连耗尽状态、重连时新 send 的处理，以及 Client 可观察事件。

### 4.6 Server 被动端不对称

`SocketIoServerTransport` 包装的是已经接受的 Socket。该 Socket 断开后 Server 无法主动恢复同一物理连接；只能等待 Browser 建立新 Socket，再创建新的 Server Transport/Session。因而“Transport 负责重连”必须明确限定：

- 主动 Client Transport 可以自己建立新的底层连接；
- accepted Server Transport 只负责当前 accepted connection 的完整生命周期，不尝试主动 reconnect；
- Client reconnect 后必须重新完成 Server 新 Session 所要求的 `session.open`。

### 4.7 文档与 Architecture Spine 冲突

以下旧决策需要更新，不能继续作为实现依据：

- `docs/architecture.md`：SDK 创建 Socket.IO Transport；`connect(url)`；一次 Socket 对应一次 Session；关闭自动重连；SDK 显式创建新 Session。
- `docs/implementation-plan.md`：同上，并把全部 Session/Transport implementations 放在一个 protocol workspace。
- Architecture Spine AD-6：Session receive state/message/error 联合事件，而最新目标要求 Session receive 只有完整消息。
- Architecture Spine AD-9：每次 SDK connect 创建新 Transport/Session，Session 绑定 receive 后连接 Transport；与稳定注入 Transport、Transport 自主重连冲突。
- Architecture Spine AD-12：Transport disconnect/fatal 立即清理全部 Session pending；与“Session 不感知 disconnect，pending 等 Response timeout”冲突。
- Architecture Spine AD-13/Structural Seed：一个 protocol implementations 子路径承载 Session 和所有 Transport；与独立发布边界冲突。
- Architecture Spine Deferred：自动重连被明确延后；最新讨论已经把自动重连纳入当前 Transport 职责。
- `AGENTS.md` 当前要求 ProtocolSession 测试“断线清理”，且把 definitions/implementations 固定在一个 protocol package；需要在新 PRD/Architecture 确认后同步修订。其分层、Codec 边界和 Transport wire/可靠性约束仍有效。

## 5. 公共 API 与包导出兼容面

| 当前公开面 | 目标影响 | 兼容性 |
| --- | --- | --- |
| `new RemoteInputClient(options)`，Transport 通过 `createTransport` 间接提供 | 构造器直接接收已创建 Transport | Breaking；现有 Browser/UI/tests 全部迁移 |
| `client.connect(url)` | URL 已封装在 Transport；大概率改为 `client.connect()` | Breaking；最终签名仍需确认 |
| `client.sendInput(text)` | 讨论中使用 `client.inputText(text)` | 名称尚未裁决；改名属于 Breaking，保留 alias 属于兼容策略 |
| `subscribe` / `subscribeNotification` | 讨论中称 `subscript`/订阅通知 | 应确认正式拼写和通知/Client-state 是否两个 API；不要把口语 typo 固化为 API |
| `RemoteInputTransportFactory` / `createTransport` | 直接实例注入后不再是主契约 | Removal/Deprecated；需决定是否保留兼容层 |
| `ProtocolSessionContract.connect/disconnect` | Session 不拥有 Transport 生命周期 | Breaking removal；Server、SDK、tests、README 全迁移 |
| `ProtocolSessionEvent.transport-state` | Client 直接观察 Transport；Session 不转发 | Breaking removal |
| `MessageTransport.subscribe(TransportEvent)` | Session 使用 message-only `receive(listener)`；Client 使用 lifecycle `on(...)` | Breaking split/rename；所有实现和 test doubles 原子迁移 |
| `MessageTransport.state` | Session 不可依赖；Client 可读取 | 可保留在 managed/lifecycle contract，不应出现在 Session data port |
| `@remote-copy/protocol/implementations` | Session 与 Socket.IO Transport 独立安装 | Breaking package/export migration |
| `@remote-copy/sdk` 依赖 `@remote-copy/protocol`，后者依赖 `socket.io-client` | SDK 应只依赖 Session/definitions；Browser 显式依赖 Socket.IO Transport | Dependency graph breaking change |
| SDK error `transport-not-ready` / `transport-connect-failed` | Transport 自己重连，send failure 可能有 delivery/connection/retry 分类 | 需稳定结构化 code 与 cause；不能靠 message string 控制流 |
| 当前 packages 均 `private: true` | 目标是独立发布 | 必须定义 publishability、semver 和 peer dependency 范围 |

当前仓库没有已发布 npm 兼容负担的证据，且 package 标记为 private；因此可以在 monorepo 内一次性原子迁移。但在首次独立发布前必须冻结包名、入口和契约，避免把临时兼容层变成永久负担。

## 6. 实现前真正阻塞的开放问题

下面问题会改变正确性或公共 API，不能留给实现者自行猜测。

### B1. 跨 connection generation 的 in-flight `send()` 语义

同一 connection generation 内重传 chunk 是安全的：接收端用 frame sequence 和 cumulative ACK 去重。断线并建立新 Socket 后，Server 会有新的 Transport/controller，序号从 0 开始；如果旧连接实际上已完整交付消息、只是最终 ACK 丢失，Transport 在新连接重发完整消息会让 Session/业务收到第二次。

必须二选一：

1. **安全且与当前 wire 兼容的默认**：旧 generation 的所有未完成 `send()` reject（建议标识 `delivery-unknown` 或明确错误码），该消息永不跨 generation 重发；Transport 自动重连只恢复后续新 send。
2. **让当前 send 跨连接存活**：新增稳定 logical connection/message identity、Server 恢复状态、跨连接 ACK/去重和保留期限；这已经是新的 resume 协议，显著扩大范围。

这也是“Transport 不会在失败后偷偷发送”之外必须补充的规则：消息在 Promise 尚未 settle 时也不能未经定义就跨新连接重复交付。

### B2. 初次连接、自动重连和显式断开的唯一状态机

至少需要确认：

- `Client.connect()` 是否调用注入 Transport 的 `connect()`，并在 `session.open` 成功后才 resolve；
- 意外断线后是立即后台重连，还是由下一次 `send()` lazy 触发；
- reconnecting 期间的新 `send()` 是进入有界队列等待、立即 reject，还是触发一次共享 reconnect；
- 重连次数、退避、单次/总 deadline 和耗尽后状态；
- 显式 `Client.disconnect()` 是否禁止后台重连，直到后续再次显式 `Client.connect()`；
- 同一 Client/Transport 是否必须支持 disconnect 后再次 connect（此前已确认为是）。

### B3. 重连后的 `session.open` 与 SDK ready gate

Transport connected 只表示能交换完整消息；Server 的新 Socket 创建的是新 Session，在 `session.open` 前会拒绝 `input.submit` / `operation.get`。Session 又不能硬编码应用方法。

必须明确 Client 如何：

- 直接订阅 Transport connected generation；
- 在每个新 connection generation 恰好执行一次 `session.open`；
- open 成功前扣住或拒绝 SDK 业务 API（注意：这是 Client 应用 gate，不是 Session 发送队列）；
- open 失败时驱动何种 Transport/Client 状态；
- 避免旧 generation 的迟到 open Response 把新 generation 错误标记为 ready。

仅有 `state === connected` 不足以区分“首次观察当前状态”和“新的 connected generation”；生命周期事件是否携带 generation/connectionId 需要 Architecture 决定。

### B4. Session 自身释放与 heartbeat 边界

Session 不再拥有 `connect/disconnect` 后仍必须有资源终止语义，否则 receive listener、pending timer、heartbeat timer 和 handler 会泄漏。需要决定：

- Session 是否提供 `dispose()`/`close()`，以及 dispose 时 pending 如何失败；
- Session 构造时立即注册 `receive`，还是显式 `start()`；
- 现有协议 Ping/Pong 是否继续由 Session 主动调度；
- heartbeat timeout 只报告 Session error，还是请求 Client/Transport 重建连接；Session 不能再直接调用 `transport.disconnect()`。

### B5. 独立发布包拓扑与最终公共名称

实现前需要冻结：

- definitions/Codec/Session/Socket.IO Transport 分别属于哪些 package；
- Client/Server Transport 是一个 package 的双端导出还是两个包；
- 包名、root/subpath exports、peer dependency 关系；
- `inputText` vs `sendInput`、`receive`、`on`、通知订阅的正式名称；
- 本次采用 major breaking 迁移，还是提供一个版本周期的 deprecated alias。

### B6. connection loss 对 Transport 队列中多条消息的失败范围

当前窗口允许跨消息，一个 connection-fatal 会清空并 reject 整个旧发送队列。若 Request A 触发 fatal，而 Request B 已排队但尚未发 frame，是否也失败，还是允许 B 在重连后发送，会改变顺序与跨 generation 语义。最安全且符合当前 `AGENTS.md` 的默认是：旧 generation 所有未完成 send 全部失败；重连后只接收新的调用。需要将其写成明确验收。

## 7. 非阻塞、可直接沿用的默认

以下内容已有一致代码和测试，不应重复开启设计，除非 PRD 明确改变：

- Session Response timeout 从完整 Request 被 Transport 确认交付后开始；早到 Response 有效。
- Session 在调用 `send()` 前登记 pending，以免丢失同步/极早 Response。
- Session 将每个并发 Request 立即交给 Transport，不串行等待上一条完整消息。
- Transport 统一拥有消息队列和背压；Session 只限制 pending Request 数量。
- Transport ACK 不替代协议 Response；Response 不代表长期 operation 已完成。
- Socket.IO wire、16 KiB chunk、8-frame window、累计 ACK、Go-Back-N、资源上限和单事件二进制通道继续作为当前实现基线。
- requestId、operationId、heartbeatId、messageId/frameSeq 继续严格隔离。
- Server accepted Transport 不主动 reconnect；新 Socket 创建新 Server Transport/Session。
- 当前不实现 Bluetooth、WebSocket、Channel、认证或跨连接 resume。

## 8. 迁移落点

| 区域 | 必须修改 |
| --- | --- |
| `packages/protocol/src/definitions` | 拆分 Session data port 与 managed lifecycle contract；移除 Session transport-state/lifecycle API；补稳定 Transport/Session errors |
| `packages/protocol/src/implementations/protocol-session.ts` | 移除 connect/disconnect/state checks/transport-state cleanup；改为 message-only receive；保留并发 pending、early Response、send failure 和 Response timeout；增加自身 dispose/start 语义 |
| `socket-io-client-transport.ts` | 从显式外部重连改为 Transport 自管恢复；保留 socket lifecycle generation；实现失败最终性、explicit disconnect cancellation 和队列策略 |
| `socket-io-server-transport.ts` | 适配新的数据/lifecycle 接口；保持 accepted socket 被动端语义 |
| `socket-io-fragment-controller.ts` | 可靠传输主体可保留；只需接入 connection generation 失败/错误分类，不应理解 requestId |
| `packages/sdk` | 构造器直接注入 Transport；移除 Socket.IO 默认 import/factory；Client 直接观察 lifecycle；初次/重连后 open gate；更新 API、errors、exports 和 README |
| `apps/server` | 组合根直接启动/观察 Transport；Session 仅处理消息；断线清理不再依赖 Session 转发 transport-state |
| `apps/client` | 显式创建/安装 Socket.IO Client Transport；更新 Client 构造、connect 参数和 API 名称 |
| package manifests/workspace | 新独立 packages、exports、dependencies/peerDependencies、publish 配置、build graph 和 lockfile |
| docs / AGENTS / Architecture Spine | 用最终决策替换旧 factory、Session lifecycle、立即断线清理、关闭自动重连和单 protocol implementations 包描述 |

## 9. 验证范围

### 9.1 Session

- 并发 Request A/B 在 A 的 `send()` 未完成时已调用 B 的 `send()`，Response 任意顺序仍只匹配自己的 requestId。
- pending 在 send 前注册；Response 早于 send resolve 仍完成，后续 send reject 不反转已完成结果。
- Transport send reject 只失败对应 pending；Response timeout 只在 send resolve 后开始。
- 无 Transport disconnected/state 事件时，已交付 Request 仍在 deadline 后超时并释放 Map。
- 未知、重复、迟到 Response 不匹配其他 Request；requestId 在 Session 允许迟到 Response 的范围内不得危险复用。
- message-only receive、Notification、typed inbound handler、Ping/Pong 和非法 Codec 消息。
- Session dispose/start：listener、pending timers、heartbeat timers 和异步 handler response 均不泄漏。
- 静态/替身测试证明 Session 从不读取 `state`，也不调用 Transport `connect()`/`disconnect()`。

### 9.2 Socket.IO Transport

保留当前所有 DATA/ACK wire、拆分/重组、顺序、跨消息窗口、ACK bypass、丢 DATA/ACK、重传耗尽、资源上限、序号边界、非法帧、断线清理和 buffer snapshot 测试，并新增：

- 同一 Transport 对象跨多个 connection generation 重连，每代 frameSeq/messageId/reassembly state 从 0 重置。
- old Socket 的迟到 DATA/ACK/connect/disconnect/error 不影响当前 generation。
- 并发 send 在 connected/reconnecting/queue-full 各状态下的确定行为。
- 多个调用只共享一个 reconnect attempt；重试/退避/deadline 和耗尽状态可控且可用 fake timers 验证。
- 显式 disconnect 同步取消 connect/reconnect timer，并阻止自动拉起；之后显式 connect 可再次工作。
- 旧 generation 的所有 in-flight/queued send 按最终决策 settle；任何 reject 的消息此后都没有 frame 发出。
- 若选择“不跨 generation 重发”，测试旧消息失败、重连成功、后续新消息成功且旧消息只交付最多一次。
- Client 主动 Transport 与 accepted Server Transport 的 lifecycle 语义分别测试，不能假设 Server 可主动 reconnect。

### 9.3 SDK / Client

- Browser 直接把预创建 Transport 注入 Client；SDK bundle/import graph 不再加载具体 Socket.IO implementation。
- `Client.connect()` 的参数与 resolve 条件符合最终 API；disconnect 后同一 Client/Transport 可再次 connect。
- Client 直接观察 Transport state/events，不经 Session 转发。
- 每个新 connection generation 执行一次 `session.open`；open 前业务调用不会越过 application ready gate。
- reconnect、reopen、业务调用并发时没有重复 open、旧 open 覆盖新 ready 或消息越过 gate。
- `inputText`/`sendInput`、状态订阅、通知订阅、operation revision 和错误映射按兼容决策验证。
- input submit 的 Transport 发送尚未完成时，独立 query/control Request 能进入 Session/Transport；SDK 自身的 busy policy不能误封锁所有 method。

### 9.4 Server

- 每个 accepted Socket 组合一个 Transport/Session，并由组合根直接观察 Transport 终止。
- 新 Socket 必须重新 `session.open`；open 前继续拒绝业务方法。
- Client reconnect 后旧 Server Session 不接收新字节，新 Server Session 不受旧 listener/handler 影响。
- 不自动发送非空真实 `input.submit`；集成 smoke 只执行 `session.open`。
- 若 operationId 需要跨 Socket 重试/查询，当前按 `client.id` 隔离的 `InputQueue` 行为另有冲突，必须由 SDK/Server operation 需求明确后补测试；这不是 Transport 自己能解决的问题。

### 9.5 Package 与全仓门槛

- 每个新 package 的 root/subpath exports、type-only/runtime 边界和消费示例有 export smoke tests。
- 从干净工作区验证 Browser 仅安装 SDK + chosen Transport，Server 仅安装 Session + chosen Transport 的依赖闭包。
- 公共 API 变化同步更新 `packages/sdk/src/index.ts`、protocol/session/transport exports、中文 README、Architecture 和 `AGENTS.md`。
- 按依赖顺序运行：

```bash
pnpm build
pnpm test:protocol
pnpm test:sdk
pnpm test:server
pnpm check
pnpm build
```

如 package 重组后改名，应同步重命名/新增专项 test script；核心门槛仍是所有 Session、Transport、SDK、Server 测试，加全仓 check/build 全部通过。

## 10. PRD 收敛建议

PRD 主体应写调用方可观察的能力与失败语义：注入组合、并发 Request、Session Response timeout、Transport delivery、自动恢复、失败最终性、应用 reopen gate、资源限制和独立安装。具体 package 目录、TypeScript interface 名称、Socket.IO frame 字段、controller 数据结构、退避算法实现放入 Architecture/Addendum。

在进入 Architecture Update 前，至少先裁决 B1-B5；其中 B1（跨连接重发）和 B3（重连后的 `session.open`）是正确性阻塞项，不能只靠实现阶段补默认。
