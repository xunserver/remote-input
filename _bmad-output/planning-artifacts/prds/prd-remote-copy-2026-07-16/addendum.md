# 技术附录：Client、Session 与 Socket.IO Transport

本附录记录供 PRD 下游 Architecture 使用的技术机制、brownfield 迁移事实、方案取舍和 Socket.IO 研究。调用方可观察的能力与验收以 `prd.md` 为准。

## 1. 最新分层模型

```text
Browser Application
  -> RemoteInputClient
       -> ProtocolSession
            -> MessageCodec
                 -> Session Transport Port
                      -> Client Transport implementation

Server Composition Root
  -> Server Transport implementation
       -> Session Transport Port
            -> MessageCodec
                 -> ProtocolSession
                      -> typed request handlers
```

各层职责的唯一所有权：

| 层 | 唯一拥有 | 明确不拥有 |
| --- | --- | --- |
| Client | `inputText`、应用 ready、`session.open` 编排、Operation 视图、SDK 状态与错误映射 | requestId、协议编码、frame、ACK、Transport 队列 |
| Session | Request/Response、requestId、Pending Request、Response timeout、Notification、handler、Ping/Pong、Codec 调用 | Transport state、connect/disconnect、重连、消息队列、chunk/window |
| Codec | 协议对象与 `Uint8Array` 转换、运行时校验 | 连接、关联、业务执行 |
| Transport | 连接、重连、完整消息队列、顺序、拆分/重组、窗口、ACK、重传、Delivery Failure | requestId、method、operationId、业务 JSON |

数据路径与生命周期路径分离：

```text
协议数据：Client -> Session -> Codec -> Transport.send
生命周期：Client / Server composition root -> Managed Transport
```

Client 可以持有并观察注入的 Transport，但不能绕过 Session 发送协议报文。

## 下游 Architecture 入口

Architecture 必须在拆分实现 Story 前固定以下内容：

1. package names、exports、semver 与 peer dependencies；
2. `SessionTransportPort`、`ClientManagedTransport`、`AcceptedServerTransport`、`TransportState` 和 lifecycle event 的准确 TypeScript 契约；
3. Transport reconnect 状态机、默认 3 次/30 秒预算的具体退避，以及显式关闭竞态；
4. Client 对每个新 generation 的 `session.open` single-flight 与 ready gate；
5. Session dispose/close、heartbeat error contract 和 listener 生命周期；
6. `inputText`、Client state subscription、Notification subscription 的最终 API 与迁移策略；
7. 结构化 Transport/Session/SDK error code 与 cause 映射；
8. 实现拆分顺序和完整测试矩阵。

## 2. 两个 Transport 能力面

以下是 Architecture 的概念 seed，不固定最终接口名称：

```ts
interface SessionTransportPort {
  send(message: Uint8Array): Promise<void>;
  receive(listener: (message: Uint8Array) => void): Unsubscribe;
}

interface ObservableTransport extends SessionTransportPort {
  readonly kind: string;
  readonly snapshot: TransportLifecycleSnapshot;

  observe(listener: (event: TransportLifecycleEvent) => void): Unsubscribe;
  disconnect(): Promise<void>;
}

interface ClientManagedTransport extends ObservableTransport {
  connect(): Promise<void>;
}

type AcceptedServerTransport = ObservableTransport;
```

同一个对象可以同时实现数据面和与自身角色对应的生命周期面。通过 TypeScript 结构化窄化，Session 只依赖 `SessionTransportPort`。`receive` 是完整消息数据面，`observe` 是 Client/组合根使用的生命周期面；不得再将 state/error/message 混为 Session 消费的单一事件联合。主动 Client Transport 才要求 `connect()`；包装 accepted Socket 的 Server Transport 构造后已经接入，不承担主动建链。

一个 data receive stream 同时只能由一个 Session 消费。receive listener 绑定到稳定的 Transport 实例，在 Transport 内部重连和 generation 切换时保持注册，直到 unsubscribe/dispose。Transport 向 listener 交付的字节必须是稳定快照或具有等价所有权保证，不能在回调后被内部 buffer 复用修改。

生命周期契约仍需在 Architecture 固定：

- `TransportState` 的最终枚举；
- `observe` 的准确名称和事件联合；
- 无丢失初始快照语义；
- reconnect attempt、错误原因和单调递增 connection generation 的字段形状；
- listener 顺序、异常隔离、取消订阅与重入规则。

## 3. Client 组合与连接流程

Browser 端的目标组合方式：

```ts
const transport = new SocketIoClientTransport({ url });
const client = new RemoteInputClient({ transport });

await client.connect();
await client.inputText(text);
const unsubscribe = client.subscribeNotification(listener);
```

准确方法名仍待 Architecture 冻结；上例表达的是消费模型。

`inputText` 在发出 Request 前生成 `operationId`，并允许高级调用方显式传入已有 ID。ID 生成后的结构化失败携带该 `operationId`；遇到 `delivery-unknown` 时，调用方先执行 `operation.get`；确认该 Operation 不存在后，才使用相同 `operationId` 重试，不能生成新的 `operationId` 盲目重发。

### 3.1 初次连接

```text
client.connect()
  -> Client 标记 connecting
  -> transport.connect()
  -> Transport connected(generation=N)
  -> Client 通过 Session 请求 session.open
  -> 写入 peer/capabilities
  -> 启动应用所需 heartbeat
  -> Client ready
  -> client.connect() resolve
```

Session 不参与 Transport connect，也不读取 state。Client 只把 `session.open` 当作普通 Session Request 使用。Client 使用 generation token 保证 single-flight；旧 generation 的迟到结果不得改变当前 generation 的 ready 状态。`client.connect()` 默认总期限 30 秒，只在 ready 后 resolve；Transport 初次建链默认期限 10 秒。如果 `session.open` 返回 ProtocolError、校验失败或总期限耗尽，Client 会关闭当前 generation、进入 error 并 reject；调用者之后可以再次显式 connect。

### 3.2 意外断线与恢复

当前已确认恢复方向：

```text
Client Transport 意外断线
  -> Client 观察到离开 connected，先清除 ready 并停止 heartbeat
  -> Transport 内部结束旧 connection generation
  -> reject 旧 generation 所有未完成 send
  -> Transport 按有限策略自行重连
  -> Client 观察新的 connected generation
  -> Client 在新 generation 执行一次 session.open
  -> open 成功后启动 heartbeat 并重新 ready
```

Session 不收到 disconnect，也不立即清理已经完成 Transport Delivery、正在等待 Response 的 Pending Request；这些 Request 由各自 Response timeout 收敛。

### 3.3 显式关闭

已确认语义：

- `client.disconnect()` 调用 `transport.disconnect()`；
- 显式关闭取消 connect/reconnect、清理 Client ready 并阻止自动拉起；
- 同一个 Client/Transport 后续 `client.connect()` 可以重新工作；
- Session 需要独立的 `dispose/close` 来释放 receive listener、timer 和 pending，但该能力不能控制 Transport。

## 4. Session 请求关联机制

### 4.1 Pending Request

概念结构：

```ts
type PendingRequest = {
  method: ProtocolMethod;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  responseTimer: ReturnType<typeof setTimeout> | null;
};
```

发送顺序：

1. 创建一个在本 Session 生命周期内不会复用的 `requestId`；
2. 在 Map 中登记 Pending Request；
3. Codec 编码 Request；
4. 调用 `transport.send(bytes)`；
5. `send` 成功后启动 Response deadline；
6. 匹配到 Response、发生 send failure 或发生 Response timeout 时，最先发生的事件终结该 entry。

Response 可能早于本地 `send` Promise 完成。Pending Request 必须在发送前登记；Response 已经终结该调用后，迟到的 send resolve/failure 与 timer callback 都是 no-op，且 send resolve 不得再启动 Response timer。

### 4.2 并发 Request

```text
request A -> pending[A] -> transport.send(A)
request B -> pending[B] -> transport.send(B)
request C -> pending[C] -> transport.send(C)
```

Session 不等待 A 的 `send` 或 Response 后再提交 B。Transport 统一排队；Response 按 requestId 独立关联，可以逆序完成。

### 4.3 Timeout 与断线

- Session timeout 只表示等待相同 `requestId` Response 超时。
- Transport Delivery 所用的排队、连接恢复、ACK 和重传时间由 Transport 自己限制。
- Transport disconnect 对 Session 不可见。
- 已交付 Request 即使底层随后断线，也继续等待 Response deadline。
- 当前未完成的 `transport.send` 若被 Transport reject，则对应的 Pending Request 立即失败。
- 未知、重复或超时后的迟到 Response 不得匹配其他 Request。

默认 Response timeout 为 10 秒。配置必须是有限正数。当前 PRD 假定公共配置范围为 1 秒至 120 秒；Architecture 在拆分 Story 前复核并冻结该范围，构造时对配置进行校验。

### 4.4 协议异常行为

| 情形 | 确定行为 |
| --- | --- |
| 未注册 Request method | 相同 `requestId` 返回 `method.unsupported`，Session 继续工作 |
| Handler 抛出 `ProtocolRequestError` | 原样返回其结构化 ProtocolError |
| Handler 抛出其他错误 | 相同 `requestId` 返回非重试 `request.failed` |
| 入站 `requestId` 与仍在处理或仍处于去重保留期的请求重复 | 不再次执行 handler，返回 `request.duplicate`；tombstone 默认最多保留 1024 条，保留期为 10 分钟；达到数量上限时淘汰最早的记录 |
| 未知、重复或迟到 Response | 只发布诊断，不匹配 Pending Request |
| 未知或迟到 Pong | 只发布诊断，不完成当前 heartbeat |
| Codec 校验失败 | 不调用 handler，不根据不可信字段回复，只发布验证错误 |

发送方仍被禁止在同一 Session 生命周期复用 `requestId`。有限 tombstone 只防御协议异常和重放，不宣称提供无限期业务幂等；Transport 的完整消息至多一次交付是正常路径的第一道保证。

### 4.5 Heartbeat

- Ping/Pong 关联和 timer 属于 Session，`heartbeatId` 不与 `requestId` 混用；
- 同一 Session 最多有一个待匹配 Pong；默认 interval 15 秒、Pong timeout 10 秒；
- Pong timeout 只在 Ping 的 `transport.send` 成功后启动；
- Client 只在当前 generation 的 `session.open` 成功后启动，在 Transport 离开 connected 时停止；
- `stopHeartbeat` 递增内部 run epoch；旧 run 的 send callback、timer 和迟到 Pong 至多产生一次诊断，不能修改新 run 或新 generation 的状态；
- heartbeat timeout 停止 heartbeat 并发布结构化 Session error，不批量终结正在等待普通 Response 的 Pending Request，也不直接操作 Transport；
- Client 收到 heartbeat timeout 后，先清除 ready，再串行执行 Client Transport 的 `disconnect()` 和 `connect()`，以强制创建新 generation。Transport 继续拥有建链和重试状态机。Server 组合根则关闭当前 accepted Transport；
- 直接组合 Session 的调用方不调用 `startHeartbeat` 时，不会隐式启动心跳。

### 4.6 Session 自身释放

移除 Session `connect/disconnect` 后仍需要幂等 `dispose/close`：

- 取消 message receive listener；
- 停止 Response/heartbeat timer；
- 拒绝或释放剩余 Pending Request；
- 阻止已经启动的旧异步 handler 向已销毁的 Session 写入 Response；
- 不调用 Transport disconnect。

## 5. Transport 队列与 Delivery 语义

### 5.1 完整消息队列

每个 `send(message)` 接收一条完整消息并返回独立 Promise。Transport 可以把多条消息拆成 frame 并让窗口跨消息：

```text
message A -> A0 A1 A2 A3
message B -> B0 B1

window: [A0 A1 A2 A3 B0 B1]
```

Transport 必须保持提交顺序和消息边界。Session 不提供 `sendBatch`，也不维护平行发送队列。

### 5.2 Promise 完成

- resolve：该消息所有 DATA frame 已被对端 Transport 累计 ACK；
- reject：Transport 已终结本地调用，并保证以后不再发送该消息的新 DATA frame；
- resolve 不代表对端 Session Response；
- 协议 Response 不代表长期 Operation 已进入 terminal 状态；
- 长期 Operation 的 terminal 状态只由 operation status/result 表达。

Reject 的 Delivery outcome 分两类：

- `not-delivered`：可以证明该消息没有 DATA frame 离开本地，例如超限、未 connect 或显式关闭后的新调用；
- `delivery-unknown`：DATA 可能已离开本地但完整累计 ACK 缺失，例如最终 ACK 丢失、连接中断或 generation-fatal 清理。

`delivery-unknown` 不证明对端未收到或未处理，SDK 不得自动创建新的 Operation 重试。需要重试业务时，应复用或查询相同 `operationId`。

### 5.3 Failure Finality

一旦 `send` reject：

- 从发送队列和 window 移除该消息的全部状态；
- 取消相关 timer；
- 旧 Socket callback、重连或离线缓冲不得重新发送其 frame；
- Transport 可以恢复以服务后续新消息，但不能复活旧 Promise。

这里的 finality 是本地发送状态的 finality，不是远端执行证明。Socket.IO 最终 ACK 丢失时，对端可能已经完整接收；Transport 只能保守返回 `delivery-unknown`。

### 5.4 Call-local 与 Connection-fatal

| 失败 | Transport 行为 | Session/Client 观察 |
| --- | --- | --- |
| 单消息过大 | 只拒绝该 `send` | `not-delivered` |
| 新提交导致队列条数/字节超限 | 只拒绝新 `send` | 结果为 `not-delivered`，原因为 capacity failure |
| 尚未首次 connect、显式 disconnect 后的新调用 | 不入队 | 结果为 `not-delivered`，原因为 not-connected failure |
| 无法建立连接或连接恢复预算耗尽 | 拒绝受影响 send；进入可观察错误状态 | 未发出 DATA 为 `not-delivered`，否则 `delivery-unknown` |
| 非法 frame、重组无进展、重传耗尽、序号耗尽 | 当前 generation fatal；清空并拒绝全部未完成 send | 已发出 DATA 为 `delivery-unknown`，可证明未发出则为 `not-delivered` |
| Transport Delivery 成功但无 Response | Transport 无后续动作 | Session Response timeout |

### 5.5 主动 Client Transport admission

| 生命周期 | 新 `send` | 已入队 `send` |
| --- | --- | --- |
| 尚未首次显式 `connect` | 立即 `not-delivered` | 不适用 |
| `connecting` | 立即 `not-delivered` | 不适用；初次建链默认期限 10 秒 |
| `connected` | 正常进入统一队列 | 正常窗口调度 |
| 意外断线或 connection-fatal 后的 `reconnecting` | 立即 `not-delivered` | 旧 generation 的所有未完成项按 §6 终结 |
| 显式 `disconnect` 后 | 立即 `not-delivered` | 全部终结并取消自动恢复 |
| 恢复预算耗尽后的 `error` | 立即 `not-delivered`，直到再次显式 `connect` | 不适用 |

已确认默认最多 3 次 reconnect、总恢复期限 30 秒。Client 在应用未 ready 时拒绝业务调用；Transport 还会拒绝不存在 connected generation 时发起的新 `send`。因此，新连接不会在 `session.open` 之前积压或发送业务 Request。

## 6. Connection Generation 边界

当前 wire 只保证单 connection generation 内 frame 去重与累计 ACK。新 Socket 的 frame/message/ACK/reassembly 状态从初始值重建。

已确认规则：

- 旧 generation 的所有未完成 `send` 在连接结束时 reject；已发出 DATA 的调用结果为 `delivery-unknown`；
- 新 generation 只接受之后的新调用；
- 不把旧 message 跨 Socket 重放；
- 旧 Socket 的迟到 DATA、ACK、disconnect、connect_error 不得污染新 generation。

若未来需要让未完成 `send` 跨 Socket 存活，必须另行设计稳定 logical connection ID、resume 握手、Server 状态保留、跨连接消息序号、ACK offset、去重和恢复期限。本次不实现。

## 7. 主动端与被动端

| Transport | 连接能力 |
| --- | --- |
| Socket.IO Client Transport | 主动 connect；意外断线后可自行创建新 Socket generation |
| Socket.IO Server Transport | 构造时包装已 connected/accepted Socket，不要求主动 `connect()`；该 Socket 关闭后只能由 Server 等待新连接并创建新组合 |

“Transport 负责重连”只要求具备主动建链能力的实现自行恢复。被动 Server Transport 仍负责当前 accepted connection 的可靠交付与清理。

## 8. Socket.IO Wire 与可靠传输

### 8.1 单一事件

Socket.IO Client/Server Transport 只使用：

```text
protocol:frame
```

Transport 不使用业务 method 作为 Socket.IO event，也不解析业务 JSON。

本产品的 DATA/ACK frame 只能发送到当前处于 connected 状态的 generation。实现必须绕过或清空 Socket.IO 离线发送缓冲，并使用 generation token 隔离所有 listener/callback；旧 Socket 不得在本地 `send` 已终结后发出缓存 frame。

### 8.2 DATA frame

DATA frame 使用 28-byte 大端 header，随后紧跟 payload：

```text
u16 magic = 0x5243
u8  frameVersion = 1
u8  kind = 1
u32 frameSeq
u32 messageId
u32 chunkIndex
u32 chunkCount
u32 totalMessageBytes
u32 payloadBytes
u8  payload[payloadBytes]
```

### 8.3 ACK frame

ACK 固定 8 bytes：

```text
u16 magic = 0x5243
u8  frameVersion = 1
u8  kind = 2
u32 nextExpectedFrameSeq
```

ACK 是累计确认，绕过 DATA window，且不再被 ACK。

### 8.4 序号与默认限制

- 每个新连接双向独立从 `frameSeq=0`、`messageId=0`、`nextExpectedFrameSeq=0` 开始；三者分别连续递增且不得回绕；
- DATA `frameSeq` 最大 `0xfffffffe`，`0xffffffff` 只用于最终累计 ACK；`messageId` 或序号即将回绕时必须按 connection-fatal 失败并换新 generation；
- 默认 chunk payload 16 KiB；
- 默认 DATA window 8 frames；
- 默认 ACK deadline 2 秒；
- 初次发送之外最多 3 轮重传；
- 默认重组无进展 deadline 10 秒；
- 单消息最多 256 KiB；
- 队列最多 128 条且总计不超过 4 MiB。

### 8.5 Go-Back-N 与重组

- 发送端维护跨消息 DATA frame queue 和累计 send base；
- DATA window 必须允许跨消息边界；
- ACK 只有严格推进累计进度时才重置重传 deadline；
- 接收端只接受恰好等于 `nextExpectedFrameSeq` 的 DATA；
- 重复或越序 DATA 不接受 payload，并回复当前累计 ACK；
- 只有完整重组且长度一致后才交付一条 `Uint8Array`；
- 空消息编码为一个零 payload DATA frame；
- 非 canonical chunk 元数据、未来 ACK、长度矛盾或超限 frame 均按非法 frame 处理。

## 9. Package 与消费边界

目标消费关系：

```text
Browser Application
  -> SDK package
  -> chosen Client Transport package

Server Application
  -> Session/runtime package
  -> chosen Server Transport package

Shared
  -> protocol definitions / Codec contracts
```

要求是独立安装、版本化和发布；最终 package 名称、Session/Codec/definitions 物理归属、Client/Server Transport 是否同包以及 peer dependency 范围由 Architecture 决定。保留一个 `@remote-copy/protocol/implementations` 子路径不足以自动满足独立发布目标。

## 10. Brownfield 迁移 Ledger

| 当前实现 | 目标变化 |
| --- | --- |
| SDK 接收 `createTransport(url)`，默认导入 Socket.IO | Client 直接接收调用者创建的 Transport；SDK 不选择具体实现 |
| `client.connect(url)` | Transport 已封装目标；目标为无 URL `connect()` |
| Session `connect/disconnect` 调用 Transport | 移除连接生命周期；增加独立 Session dispose/close |
| Session 读取 `transport.state` | 删除所有状态检查 |
| Session 订阅 state/message/error 联合 | Session 只 `receive` 完整消息；Client/组合根单独观察 lifecycle |
| disconnect/error 立即清空全部 Session pending | 已交付 Request 等 Response timeout；未完成 send 由 Promise failure 收敛 |
| Socket.IO Client `reconnection:false`、外部显式再 connect | Transport 内部实现有限自动恢复，并显式隔离每个 generation |
| SDK 每次 connect 创建新 Transport/Session | Client 持有注入的可复用 Transport；Session 生命周期由 Client 组合决定 |
| protocol implementations 包含 Session 与所有 Transport | 按独立发布目标重组 package/exports |
| `sendInput` 与多种 subscribe API | private workspace 原子迁移到 `inputText` 和新的状态/通知订阅；不保留运行时兼容别名 |

Operation 缓存迁移还必须删除或隔离当前允许以相同 revision 进行 synthetic 替换的特例：权威缓存只接受严格更高的 revision，本地 optimistic 投影不能写入带 revision 的权威缓存。

必须同步迁移 definitions、implementations、SDK、Server、Browser Client、测试替身、package exports、README、`docs/architecture.md`、`docs/implementation-plan.md`、Architecture Spine 和 `AGENTS.md`。

## 11. Socket.IO 官方能力边界

- Socket.IO 保证实际到达事件的顺序，但默认 Delivery 是 at-most-once；连接在发送中断开时不能保证对端是否已收到，重连后也不会自动重发该在途事件。[Delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/)
- Client 离线 emit 默认缓存在内存并在重连后发送，Server 没有对称的默认离线消息缓冲；Transport 必须控制自己的队列，不能让 Socket.IO buffer 复活已经失败的产品消息。[Offline behavior](https://socket.io/docs/v4/client-offline-behavior/)
- Event acknowledgement 只表明接收 handler 调用了 ACK callback，不能替代本项目的 Transport ACK、协议 Response 或 Operation completion。[Emitting events](https://socket.io/docs/v4/emitting-events/#acknowledgements)
- Connection state recovery 必须显式启用、受保存期限和 adapter 支持限制，且官方明确说明恢复不保证成功。[Connection state recovery](https://socket.io/docs/v4/connection-state-recovery/)

## 12. 已覆盖的旧方案

以下结论保留为 rejected-alternative rationale，不再进入目标架构：

1. **每次连接由 SDK 调用 factory 创建新 Transport/Session。** 该方案已由“调用方创建稳定的 Transport 实例并将其注入 Client”取代。
2. **Session 管理 Transport connect/disconnect。** 该方案已由“Client/组合根管理显式生命周期，Transport 自行管理意外恢复”取代。
3. **Session 在发送前检查 state 并触发 reconnect。** 该方案已由“Session 只调用 `send`”取代，因为状态检查存在竞态且复制职责。
4. **Transport disconnect 时 Session 立即清空 Pending Request。** 当前方案改为：已完成 Transport Delivery 的 Request 等待 Response timeout，未完成的 send 由 Transport failure 收敛。
5. **Session 拥有 ready/not-ready 连接状态。** 应用 ready 属于 Client，连接 state 属于 Transport；Session 只有协议调用的 pending/success/failure。
6. **Session 在前一 Request 完成前扣住后续 Request。** Transport 已经拥有队列和背压；Session 立即提交并发 Request。
7. **失败消息在新连接继续发送。** reject 是本地终态；跨连接 resume 明确不在本次范围，但失败结果必须区分 `not-delivered` 与 `delivery-unknown`。
