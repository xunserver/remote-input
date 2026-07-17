# 对话更新提取：Client / Session / Transport 收敛模型

## 提取范围

- 对照基线：`prd.md`、`addendum.md`、`.memlog.md` 当前内容。
- 变更信号：`.memlog.md` 最后一条记录之后，尤其是用户两次 `cancel` 后重新提出并逐步澄清的 Client、Session、Transport 架构。
- 本文件只提取对话事实、冲突和未决项；不修改 PRD、技术附录或决策日志。
- 置信度标签：
  - **Confirmed**：用户直接陈述，或后续直接纠正到该结论。
  - **Inferred**：助手提出后用户没有逐条确认，但继续讨论并最终表示“东西基本确定完了”。
  - **Still open**：对话明确留下、或新模型成立所必需但尚未裁决的内容。

## 最新目标模型

```text
Browser Application
  -> new Client({ transport })
       -> inputText() / notification subscription
       -> Session
            -> requestId + pending request Map + response timeout
            -> MessageCodec（沿用仓库既有强制分层）
            -> Transport.send(完整消息)
            <- Transport.receive(完整消息)

Transport
  -> 连接与重连
  -> 消息队列、背压和顺序
  -> 拆分、跨消息窗口、累计 ACK 和重传
  -> 完整消息级交付成功或失败
```

最新讨论的核心改变是：**Session 是与连接状态无关的请求/响应关联器；Transport 是连接与可靠交付的唯一所有者。** Client 可以观察和控制 Transport 生命周期，但协议数据仍必须经过 Session。

## Confirmed：用户直接确认的决定

### C-01 Client 采用已创建的 Transport 实例注入

Browser 引入 SDK 导出的 Client，调用者先创建具体 Transport，再将该实例传给 Client：

```ts
const transport = new SocketIoClientTransport(options);
const client = new Client({ transport });
```

这覆盖了 `.memlog.md` 中“SDK receives a Transport factory”的旧决定。新公开组合方式是实例注入，不要求调用者传入 factory。

### C-02 SDK Client 是应用层入口

Client 对外提供远程输入与通知订阅能力。对话中明确点名：

- `client.inputText(...)`；
- `client.subscript(...)`（命名可能意指 `subscribe`，最终 API 拼写仍需核对）；
- Client 把业务调用交给 Session，不能直接构造或发送 Transport 业务报文。

### C-03 Session 负责协议请求关联

Session 接收 Client 的业务调用后：

1. 将调用转换为协议 Request；
2. 生成并写入 `requestId`；
3. 在内部 `pending request Map` 中登记请求；
4. 将编码后的完整消息交给 Transport；
5. 收到 Response 后按相同 `requestId` 关联并完成请求。

### C-04 Session 对 Transport 只依赖完整消息级 `send` 与 `receive`

用户明确要求 Session 看到的 Transport 能力只有：

- 发送一条完整消息；
- 注册函数接收一条完整消息。

Transport 的连接、连接状态、拆分、窗口、ACK、重传和重连机制均不进入 Session 数据面契约。仓库既有 `MessageCodec` 分层没有在本轮被否定，仍位于 Session 与字节 Transport 之间。

### C-05 Transport 是连接与重连的唯一所有者

Transport 自己负责：

- 当前没有可用连接时建立或恢复连接；
- 连接中断后的内部重连；
- 同一消息的分片、窗口化发送、ACK 和有限重传；
- 判断一条完整消息最终交付成功还是失败。

Session 不调用 `connect()` / `reconnect()`，不检查 `transport.state`，也不根据 disconnect 事件执行重连编排。

### C-06 Session 不感知 Transport disconnect，也不因 disconnect 立即清理 pending

用户明确否定了 Session 对连接代际或断线事件的依赖：

- Session 不需要知道 Transport 已经 disconnect；
- 已经进入 pending Map、但尚未收到 Response 的 Request 继续等待自身的 Response timeout；
- 不要求 Transport 向 Session发布 `epoch-close`，也不要求 Session 在断线时立即拒绝所有 pending Request。

### C-07 Session 保留 Request/Response timeout

用户先出现一次表述修正，随后明确确认：Session 的 timeout 是 **requestId 对应 Response 的等待超时**。

这与 Transport 交付失败是两个不同概念：

```text
Transport delivery result
  = 完整消息是否被可靠交付给对端 Transport

Session response timeout
  = Request 已提交后，是否在期限内收到相同 requestId 的 Response
```

Session 的 Response timeout 最终表现为该 Request 失败，不需要成为公共 Session 连接状态。

### C-08 Transport 的 chunk 重试耗尽属于消息交付失败

一条消息被 Transport 分为多个 chunk 后，如果某个 chunk 多次尝试仍无法被对端确认，Transport 对这条完整消息报告发送失败。用户特意区分了术语：这里应表达为 **数据/消息发送失败（delivery failed）**，而不是 Session 的 Response timeout。

Transport 也可能因为无法连接对端而拒绝发送。无论底层原因是什么，Session 只接收本次 `send()` 成功或失败的结果。

### C-09 `send()` 判定失败后，该消息绝不再被发送

Transport 是一条消息最终失败状态的唯一裁决者。Transport 一旦对 `send(message)` 返回失败：

- 必须放弃这条消息；
- 后续内部连接恢复不得使这条已失败消息重新进入发送；
- Session/Client 可以确信失败调用不会在后台迟到交付。

### C-10 Transport 发送失败逐层暴露给 Client

当 `transport.send()` 最终失败：

```text
Transport delivery failure
  -> Session 对应 Request 失败并清理 pending
  -> Client.inputText() / 其他调用 reject
  -> 调用者获得 Transport 交付错误原因
```

Session 不替 Transport 隐藏或转换为成功，也不在这一层重试协议 Request。

## Inferred：已形成工作共识但缺少逐条直接确认

### I-01 Session 不建立第二套发送队列

用户提出并发场景：第一个 `inputText` 尚未完成时，Client 又发出状态查询或控制 Request。助手给出的结论是第二个 Request 仍立即交给 Transport；Session 只分别维护两个 requestId 的 pending 项。用户没有反对，并继续讨论状态所有权，最终表示架构“基本确定完了”。

当前工作共识应是：

```text
request A -> pending[A] -> transport.send(A)
request B -> pending[B] -> transport.send(B)
```

Session 不等待 A 完成后才提交 B，也不维护串行发送队列。

### I-02 Transport 统一承担消息队列、背压、顺序与跨消息窗口

由 I-01 推导，Transport 必须接受并发 `send()`，并负责：

- 排队和资源上限；
- 保持完整消息边界和消息顺序；
- 允许发送窗口跨越多条消息；
- 分别完成或拒绝每个 `send()` Promise。

该结论与仓库 `AGENTS.md` 既有约束一致，但本轮用户没有逐条确认调度细节。

### I-03 Response 可以乱序返回，由 requestId 独立关联

多个 Request 可以并发 pending，因此 Response 不应依赖发送完成顺序；Session 按 requestId 独立完成对应 Promise。这是 pending Map 和并发提交的必要推论。

### I-04 Client 可以观察 Transport 生命周期

用户提出 Client 已持有具体 Transport，因此可以读取 `transport.state`，也可以由 Transport 提供 `transport.on(...)` 生命周期事件。助手建议 Client 需要观察，Session 不需要。用户随后表示整体基本确定。

工作共识是：

- `transport.state` 提供状态快照；
- `transport.on(...)` 或等价订阅提供后续变化；
- Client 可用它们呈现连接状态、编排应用层生命周期；
- UI 应通过 Client 暴露的 SDK 状态订阅，而不是绕过 SDK 直接解析协议消息。

但准确事件/API 形状仍属未决项 O-03。

### I-05 Client 的生命周期观察不改变协议数据路径

即使 Client 持有并观察 Transport，所有业务协议消息仍遵循：

```text
Client -> Session -> MessageCodec -> Transport
```

Client 不得因为知道 Transport 类型而绕过 Session 调用 `send()` 发送 Request。

## Still open：进入最终 PRD 前需要裁决或明确延期

### O-01 首次连接与显式生命周期 API

尚未最终确认：

- Client 是否继续公开 `connect()` / `disconnect()`；
- 首次连接必须由 `await client.connect()` 触发，还是允许首次 `inputText()` 促使 Transport 懒连接；
- 显式 `disconnect()` 后，新 `send()` 是直接失败、允许 Transport 再连接，还是必须先调用 Client `connect()`。

该项关系到“主动断开”的用户意图，不能只靠 Transport 自动重连推断。

### O-02 Transport 自动重连的触发和终止策略

已确认重连归 Transport，但以下机制未定：

- 断线后立即后台重连，还是下一次 `send()` 时按需 `ensureConnected()`；
- 退避、最大尝试次数和总截止时间；
- 达到重连预算后的状态；
- 后续新消息是否可以启动新一轮恢复；
- 手动断开如何抑制自动恢复。

这些属于技术附录/架构机制，但 PRD 需要定义调用者可观察到的能力和失败边界。

### O-03 Transport state 与生命周期事件契约

方向已形成，但准确公共契约尚未确认：

- `state` 的枚举集合；
- `on()` 是通用事件订阅还是 `onStateChange()`；
- 是否暴露 reconnecting、错误原因、重连次数或连接代际；
- 初始订阅如何获得快照；
- Client 向 SDK 使用者映射哪些状态。

### O-04 新 Socket 后的 `session.open` 语义

当前 Server 在新 Socket 上要求先执行 `session.open`。Transport 内部重连可能得到一个全新的 Socket，但 Session 又完全不感知连接代际。仍需确定：

- Client 是否通过 Transport 生命周期事件识别新连接，并自动再次调用 `session.open`；
- Transport 是否能够恢复同一逻辑连接，使上层不需要重新 open；
- reopen 期间新的 `inputText()` / query 应等待、排队还是失败。

按当前 Server 实现，最小方案倾向于 Client 在新连接上重新 open；这仍是建议/推论，不是用户已确认决定。

### O-05 Session Response timeout 的起算点与默认值

已确认 Session 有 requestId Response timeout，但尚未确认：

- 从 Request 创建/进入 pending 时起算，还是 `transport.send()` resolve 后起算；
- 默认期限、是否可按 method 配置；
- Response 在 `send()` Promise 完成之前到达时如何收敛结果；
- 超时后的迟到 Response 是忽略、记录还是暴露诊断事件。

### O-06 并发发送的精确失败范围

Transport 接受 A、B 等多条消息后，如果 A 的 chunk 重试耗尽：

- 只拒绝 A；
- 还是认为底层连接已不可信，拒绝当前队列和窗口中的全部未完成消息；
- B 若尚未发送任何 chunk，是否允许在重连后继续；

尚未由用户裁决。无论选哪一种，每个已经 reject 的消息都必须遵守 C-09。

### O-07 通知订阅 API 的最终名称与语义

用户使用了 `Client.subscript` 表述通知订阅。需要核对是否沿用当前 SDK 的 `subscribe`/特定 operation 订阅 API，以及订阅涵盖：

- 协议 notification；
- SDK/Client 状态变化；
- Transport 状态变化；

这些是否使用同一入口仍未确认。

### O-08 Server 侧 Transport 的重连适用性

Browser Client Transport 可以主动建立连接；Socket.IO Server Transport 包装的是对端已经接受的 socket，断开后通常只能等待新 socket。新模型尚未明确：

- “Transport 自己负责重连”是否只适用于主动端 Transport；
- Server 新 socket 是否创建新的 Transport + Session；
- 是否需要跨 socket 恢复既有逻辑 Session。

不能把 Browser 主动端的自动重连能力无条件写成所有 MessageTransport 的统一要求。

### O-09 pending request 资源上限

Session 不因 Transport disconnect 立即清理 pending，而是等待每个 Request 的 Response timeout。因此需要定义 pending Map 的最大数量、超限错误和销毁时清理；本轮尚未讨论具体限制。

## 对旧决定的覆盖与冲突

| 旧决定/描述 | 最新结论 | 状态 |
| --- | --- | --- |
| SDK 接收 Transport factory，每个连接代际创建实例 | Client 接收调用者已创建的稳定 Transport 实例 | **Overridden by C-01** |
| Session 独占并管理 Transport 的 connect/disconnect/listener 生命周期 | Session 数据面只依赖 send/receive；Transport 管理连接和重连 | **Overridden by C-04/C-05** |
| `client.connect -> session.connect -> transport.connect` | Session 不调用 connect；Client/Transport 的首次连接流程仍待 O-01 裁决 | **Superseded; replacement partly open** |
| Session 在发送前检查 `transport.state` 并调用同实例 `connect()` | Session 不读取 state；Transport 在内部保证连接或拒绝 send | **Overridden by C-05/C-06** |
| Unexpected disconnect 触发 Session 自动重连 | Transport 自己重连，Session 完全不编排重连 | **Overridden by C-05** |
| Session 拥有 `ready/not-ready` 并由 Transport state 派生 | 最新模型未要求 Session 公开连接 readiness；Session 只处理请求成功/失败 | **No longer supported; remove unless separately justified** |
| Transport disconnect 时 Session 停止心跳并立即拒绝当前 generation pending | Session 不感知 disconnect；pending 等待 Response timeout，未完成 send 由 Transport 决定 | **Overridden by C-06/C-07** |
| Session 需要 lifecycle generation/epoch-close 来隔离旧连接 | Session 不需要接收连接代际事件；连接代际隔离留在 Transport 内部 | **Overridden for Session; retained internally for Transport implementation** |
| Session 私有 `allowConnect`/started gate 区分主动与意外断开 | Session 不拥有重连控制；主动断开的 gate 应落在 Client/Transport，具体语义见 O-01/O-02 | **Moved out of Session; still open** |
| 断线后旧 pending Request 立即失败，重连只恢复未来调用 | pending 不因断线立即失败，继续等待 Response timeout | **Overridden by C-06** |
| SDK 在每个新 connection generation 重新 `session.open` | 需求仍存在，但谁感知新连接、何时 reopen 尚未确认 | **Still open: O-04** |
| 同一个 Client 支持 disconnect 后再次 connect | 最新讨论没有撤销，但与自动重连和显式断开语义需在 O-01 一并确认 | **Retained, semantics open** |

## 不构成冲突、可继续沿用的既有约束

- Client/SDK、Session、Transport implementation 是独立的发布和组合边界。
- Browser 安装 SDK 与选定的 Client Transport；Server 不依赖 SDK，直接组合协议能力与 Server Transport。
- 当前实现范围是 Socket.IO；WebSocket/Bluetooth 只作为未来可插拔性约束，不在本次实现。
- Transport 只交付完整、可靠、有序、保留消息边界的字节消息；Socket.IO Transport 内部承担 frame wire format、拆分、重组、ACK、窗口、重传和资源限制。
- Codec 继续是协议对象与 `Uint8Array` 之间的独立边界；Transport 不解析业务 JSON。
- `requestId` 只负责一次 Request/Response 关联；Transport frame/message 序号不泄漏到 Session。
- Session 的 Response timeout 和 Transport 的 delivery failure 是两个独立失败域。

## 可直接用于 PRD 的能力表述候选

以下是对已确认内容的产品能力提炼，不包含具体 Socket.IO 算法：

1. SDK 使用者能够创建具体 Client Transport 并将其注入 Client，而无需直接创建 Session。
2. Client 能够提交远程输入请求并订阅服务端通知；所有协议调用均经由 Session。
3. Session 能够并发关联多个 Request/Response，并在 Response deadline 到达时独立失败对应 Request。
4. Session 与 Transport 的交互仅以完整消息的发送结果和完整消息接收为依据，不依赖连接状态。
5. Transport 能够在内部建立和恢复连接，并在其交付预算内完成拆分、窗口发送、ACK 和重传。
6. Transport 必须为每条完整消息给出确定的交付成功或失败；失败后不得迟到交付该消息。
7. Transport 的失败必须沿 Session 暴露给对应 Client 调用，同时不错误完成无关 requestId。
8. 多个上层调用可以并发进入 Session；排队、顺序、背压和发送资源限制统一由 Transport 承担。
9. Client 可以观察 Transport 生命周期以呈现连接可用性，但不得由此绕过 Session 发送业务协议消息。

## 建议在 PRD 收敛时先解决的阻塞项

优先级从高到低：

1. **O-01 + O-02**：首次连接、显式 disconnect 和 Transport 自动重连的可观察语义。
2. **O-04**：Socket.IO 新连接后的 `session.open`，否则“Session 完全无感重连”与当前 Server 握手要求无法同时落地。
3. **O-05**：Session Response timeout 起算点，直接决定调用最长等待时间和 pending 生命周期。
4. **O-06**：跨消息窗口发生链路失败时，各 `send()` 的失败范围。
5. **O-03/O-07**：Client 对外状态与订阅 API 的准确表面。

其余机制可以在架构阶段细化，但 PRD 至少要写清调用者能观察到的行为与错误边界。
