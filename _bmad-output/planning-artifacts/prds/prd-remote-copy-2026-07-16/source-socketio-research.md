# Socket.IO 4.x 能力与可靠性边界研究

**研究日期：** 2026-07-16  
**用途：** Remote Copy PRD Discovery 输入  
**来源范围：** 仅使用 Socket.IO 4.x 官方文档与 `socketio/socket.io` 官方仓库  
**置信度：** 高；关键 delivery 结论来自官方专页，并用 Client API、协议文档和官方源码交叉核对

## 摘要

Socket.IO 4.x 提供双向事件 API、二进制参数、连接探测、自动重连和跨底层 transport 的事件顺序保证。它保证的是：**实际到达的 Socket.IO 事件保持发送顺序**。默认 arrival guarantee 仍是 **at-most-once**；连接在发送中断开时，发送方无法据此断定对端是否收到，重连后也不会自动重发该事件。

Socket.IO ACK、客户端 `retries`、离线缓冲和 connection state recovery 可以增强部分场景，但它们不是统一的 durable/exactly-once 语义。官方文档明确把额外 delivery guarantee 留给应用实现；Server 到 Client 的 at-least-once 示例需要应用自行分配事件 ID、持久化事件并维护客户端 offset。

## 版本基线

- 官方文档页面均标记为 **4.x**。
- 官方仓库当前发布页显示 [`socket.io@4.8.3`](https://github.com/socketio/socket.io/releases/tag/socket.io%404.8.3)。
- Client API 显示当前 Socket.IO protocol revision 为 `5`；Client 与 Server 必须使用相同协议 revision 才能互相理解。[Client API](https://socket.io/docs/v4/client-api/#ioprotocol)

## 能力事实矩阵

| 主题 | Socket.IO 4.x 官方能力 | 明确边界 |
| --- | --- | --- |
| 低层连接 | Engine.IO 在 Socket.IO 下负责建链、transport upgrade 和断线探测；可使用 HTTP long-polling、WebSocket 或 WebTransport。 | Socket.IO 不是裸 WebSocket 协议；底层 transport 可在连接期间升级。 |
| 事件顺序 | 到达事件保持发送顺序，包括 HTTP long-polling 升级到 WebSocket 的过程。 | 官方限定为“provided that they actually arrive”；顺序保证不等于到达保证。 |
| 默认 delivery | 默认 at-most-once。 | 发送中断链时不能确认对端是否收到；重连不自动重发该在途事件。 |
| 二进制事件 | `Buffer`、`TypedArray` 等二进制对象可直接作为事件参数。 | 一个 Socket.IO binary event 在线上可能编码成元数据 packet 加一个或多个 binary attachment。 |
| Event ACK | 事件可携带 ID，请求对端回传相同 ID 的 ACK；API 支持 callback、timeout 和 `emitWithAck()`。 | ACK 的 payload 与调用时机由接收端 handler 决定；timeout 只表示期限内未收到 ACK。 |
| Client 重试 | `retries + ackTimeout` 可让 Client 重发，直到 Server ACK，最多尝试 `retries + 1` 次。 | 官方把它描述为 Client 到 Server 的 at-least-once；浏览器刷新会丢失尚未完成的事件。 |
| Client 离线缓冲 | Client 在未连接时发出的非 volatile 事件默认进入内存 buffer，重连后发送。 | 官方警告重连时可能形成事件突发；发送中断链的在途事件仍不保证重试。 |
| Server 离线缓冲 | 默认没有给断线 Client 的 Server-side message buffer。 | 断线期间 Server 发给该 Client 的事件不会仅因之后重连而补送。 |
| 自动重连 | Client Manager 默认启用 reconnection；默认无限次尝试，并采用带随机因子的退避。 | 手动 `socket.disconnect()` 或 Server 强制 namespace disconnect 不自动重连；临时 transport/ping failure 通常自动重连。 |
| Connection recovery | 可选的 connection state recovery 可在短暂、意外断线后恢复 `socket.id`、rooms、`socket.data` 和漏收 packets。 | 必须由 Server 显式启用、受保存时长和 adapter 支持限制，且官方明确说明恢复不总能成功。 |
| 心跳 | Engine.IO 使用 Server PING / Client PONG 检测低层连接；默认 `pingInterval=25s`、`pingTimeout=20s`。 | 该心跳确认连接活性，不表达某个应用请求或远端业务操作已完成。后一句是基于层次语义的推论。 |
| 单消息大小 | Server `maxHttpBufferSize` 默认 1 MB；单条消息超过限制时关闭 socket，可配置调高或调低。 | 二进制支持不意味着任意大小事件都可无界发送。 |

## 连接生命周期

### Engine.IO 与 Socket.IO 分层

官方把实现拆成 Engine.IO 低层连接和 Socket.IO 高层事件 API。Engine.IO 管理 transport、upgrade、握手和断线检测；握手包含 `sid`、可升级 transport、`pingInterval`、`pingTimeout` 与 `maxPayload`。[How it works](https://socket.io/docs/v4/how-it-works/)

Client `Manager` 负责低层连接和 reconnection，namespace `Socket` 负责收发事件。`autoConnect` 和 `reconnection` 默认均为 `true`；默认 `reconnectionAttempts=Infinity`、初始延迟 1 秒、最大延迟 5 秒，并带随机因子。[Client options](https://socket.io/docs/v4/client-options/#manager-options)

### Connect / Disconnect / Reconnect

- `connect` 在首次连接和每次重连后都会触发；官方提醒不要在 `connect` handler 内重复注册普通事件 handler。[Client Socket instance](https://socket.io/docs/v4/client-socket-instance/#connect)
- 临时低层连接失败、ping timeout、transport close 和 transport error 通常允许自动重连；middleware 拒绝、Client 手动 disconnect、Server 强制 disconnect 不自动重连。`socket.active` 用于区分两类情况。[Client Socket instance](https://socket.io/docs/v4/client-socket-instance/#connect_error)
- `socket.disconnect()` 会停止该 Socket 的自动重连；如果它是 Manager 最后一个 active Socket，低层连接也会关闭。[Client API](https://socket.io/docs/v4/client-api/#socketdisconnect)
- Engine.IO heartbeat 能检测失活，但检测存在 `pingInterval + pingTimeout` 的时间窗口。[Server options](https://socket.io/docs/v4/server-options/#pinginterval)

### Socket ID 的生命周期

未启用并成功使用 connection state recovery 时，`socket.id` 是临时 ID：每次重连可能重新生成、不同 tab 不同，Server 不会为该 ID 自动保存消息队列。官方建议业务身份使用独立 session ID。[Client Socket instance](https://socket.io/docs/v4/client-socket-instance/#socketid)

## 二进制事件与消息边界

Socket.IO 事件支持任意数量的可序列化参数，包括 `Buffer` 和 `TypedArray`，调用方无需先把二进制转换成 JSON。[Emitting events](https://socket.io/docs/v4/emitting-events/#basic-emit)

Socket.IO protocol 为二进制定义 `BINARY_EVENT` 和 `BINARY_ACK`。在线格式中，一个含二进制的事件会先发送包含 placeholder 的 packet，再发送对应 binary attachment；多个二进制参数会形成多个 attachment。[Socket.IO protocol](https://socket.io/docs/v4/socket-io-protocol/#sending-and-receiving-data)

官方 parser 源码也显示：发现 EVENT/ACK 含 binary 时会转换成 BINARY_EVENT/BINARY_ACK，拆出 buffers，并在全部 attachment 到达后才向上发出解码后的 packet。[socket.io-parser source](https://github.com/socketio/socket.io/blob/main/packages/socket.io-parser/lib/index.ts)

因此可以确认的边界是：

- Socket.IO API 向应用交付的是完整事件及其重组后的参数；
- 一个应用事件不必对应一个底层 WebSocket/Engine.IO packet；
- Socket.IO 自身的 event boundary 不等于应用自定义协议中的业务 request、operation 或完成语义。

## 顺序、到达与缓冲

### 顺序

官方承诺事件顺序不受所选低层 transport 或 polling-to-WebSocket upgrade 影响。例如连续 emit 的 `event1`、`event2`、`event3`，只要实际到达，对端按该顺序收到。[Delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/#message-ordering)

### 默认到达语义

默认是 at-most-once：[Delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/#at-most-once)

- 连接在事件发送过程中断开时，不保证对端是否收到；
- 对该在途事件，重连后没有默认 retry；
- 断线 Client 发出的后续事件会在 Client buffer 中等待重连；
- Server 不会默认保存断线 Client 漏掉的 Server events。

这解释了两个不能互相替代的事实：有序事件流可能存在缺口；重连成功也不证明断线前最后一个事件是否被处理。

### Client buffer 与 volatile

Client 未连接时，普通 emit 默认缓冲，重连后 flush；官方提示这可能造成很大的瞬时事件流。`socket.connected` guard 可以避免离线 emit，`socket.volatile.emit()` 则允许连接未就绪时丢弃事件。[Offline behavior](https://socket.io/docs/v4/client-offline-behavior/)、[Volatile events](https://socket.io/docs/v4/emitting-events/#volatile-events)

官方 Client 源码对应地维护 `sendBuffer`：连接可写时直接发 packet，否则把非 volatile packet 放入 buffer；volatile packet 在 transport 不可写时直接丢弃。[socket.io-client source](https://github.com/socketio/socket.io/blob/main/packages/socket.io-client/lib/socket.ts)

## ACK 与重试

### Event ACK

发送方可以在 EVENT/BINARY_EVENT 中携带 event ID；接收方回传同 ID 的 ACK/BINARY_ACK。高层 API 支持 callback，v4.4 起支持单次 emit timeout，v4.6 起提供 Promise 形式 `emitWithAck()`。[Emitting events](https://socket.io/docs/v4/emitting-events/#acknowledgements)、[Socket.IO protocol](https://socket.io/docs/v4/socket-io-protocol/#acknowledgement)

ACK 的直接含义是“接收端调用了该事件的 acknowledgement callback”。官方 API 允许 handler 自行决定何时调用以及返回什么 payload。由此只能推导：如果 handler 在业务完成前调用 ACK，则 ACK 不能证明业务完成；如果 handler 在业务完成后调用，才由应用赋予它该语义。Socket.IO 本身没有固定这层含义。

### Client retries

Client `retries` 与 `ackTimeout` 会将事件排队并重发，直到 Server ACK 或超过 `retries + 1` 总尝试次数。[Client options](https://socket.io/docs/v4/client-options/#retries)、[Delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/#from-client-to-server)

官方将其归类为 Client-to-Server at-least-once，而不是 exactly-once。有限推论：如果 Server 已处理事件但 ACK 丢失，Client 可以再次发送同一事件，因此接收方仍需依赖应用事件 ID/幂等键识别重复。官方同时明确指出：浏览器 tab 刷新会丢失尚未完成的 pending event。

Server-to-Client 没有对应的默认 durable retry。官方 at-least-once 示例要求应用执行三件事：给事件唯一 ID、把事件写入数据库、Client 保存最后 offset 并在重连时提交给 Server，由 Server 查询和补发漏失事件。[Delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/#from-server-to-client)

## Connection State Recovery

Connection state recovery 从 v4.6 起用于临时意外断线；Server 必须显式配置保存时长。成功时可以恢复 Socket 的 ID、rooms、data 和漏收 packets，双方通过 `socket.recovered` 判断是否成功。[Connection state recovery](https://socket.io/docs/v4/connection-state-recovery/)

官方同时给出三个硬边界：

- recovery 不总能成功，应用仍需处理 Client/Server 状态重新同步；
- 它针对意外临时断线，不是手动 disconnect 的通用 session resume；
- adapter 支持不一致：内存 adapter 与 Redis Streams adapter 支持，传统 Redis Pub/Sub adapter 不支持 packet persistence。

因此 recovery 是有条件的短期补偿能力，不构成无条件的持久事件历史。

## 不能由 Socket.IO 基础能力单独推出的保证

以下均是对官方能力边界的归纳，不是产品决策：

1. **不能由顺序保证推出无缺口交付。** 官方顺序保证只覆盖实际到达的事件。
2. **不能由自动重连推出在途事件已重发。** 默认 arrival 是 at-most-once。
3. **不能由 Client buffer 推出持久队列。** buffer 位于 Client 进程内，tab refresh 会丢 pending 事件，且 Server 默认没有对称离线 buffer。
4. **不能由 at-least-once retries 推出 exactly-once。** ACK 丢失可触发重复尝试；业务去重仍需要稳定事件/operation ID。
5. **不能由 Event ACK 推出固定业务完成。** ACK 时点由 handler 决定，Socket.IO 只关联 ACK packet 与 event ID。
6. **不能由 Engine.IO heartbeat 推出应用处理健康。** heartbeat 只检测低层连接是否仍活跃。
7. **不能由 connection recovery 推出永久恢复。** recovery 有时限、adapter 条件且官方明确要求处理失败后的状态同步。
8. **不能由二进制事件支持推出无限消息大小。** `maxHttpBufferSize` 对单消息设限，超限会关闭 socket。[Server options](https://socket.io/docs/v4/server-options/#maxhttpbuffersize)

## 官方来源索引

- [Socket.IO 4.x Delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/)
- [Socket.IO 4.x How it works](https://socket.io/docs/v4/how-it-works/)
- [Socket.IO 4.x Client Socket instance](https://socket.io/docs/v4/client-socket-instance/)
- [Socket.IO 4.x Client options](https://socket.io/docs/v4/client-options/)
- [Socket.IO 4.x Client offline behavior](https://socket.io/docs/v4/client-offline-behavior/)
- [Socket.IO 4.x Emitting events](https://socket.io/docs/v4/emitting-events/)
- [Socket.IO 4.x protocol](https://socket.io/docs/v4/socket-io-protocol/)
- [Socket.IO 4.x Connection state recovery](https://socket.io/docs/v4/connection-state-recovery/)
- [Socket.IO 4.x Server options](https://socket.io/docs/v4/server-options/)
- [Official socket.io-client Socket source](https://github.com/socketio/socket.io/blob/main/packages/socket.io-client/lib/socket.ts)
- [Official socket.io-parser source](https://github.com/socketio/socket.io/blob/main/packages/socket.io-parser/lib/index.ts)
- [Official Socket.IO 4.8.3 release](https://github.com/socketio/socket.io/releases/tag/socket.io%404.8.3)
