# 输入对账：Architecture 与 Brownfield 基线

## 对账输入

- `_bmad-output/planning-artifacts/architecture/architecture-remote-copy-2026-07-16/ARCHITECTURE-SPINE.md`（现有 `status: final`）
- `docs/architecture.md`
- `docs/implementation-plan.md`
- `source-architecture-extract.md`
- `source-brownfield-extract.md`
- `source-socketio-research.md`
- `update-extract-brownfield.md`
- `update-extract-conversation.md`
- `update-extract-requirements.md`

目标产物：当前 `prd.md` 与 `addendum.md`。

## Gate 结论

**需要小范围需求收口后才能进入 Architecture Update。** 最新 PRD 已经正确覆盖本轮最重要的旧决定：调用者创建并注入稳定 Transport 实例、Session 不管理连接或读取 Transport state、Session 不因 disconnect 立即清空已交付 Request、并发 Request 不在 Session 串行、失败消息不跨连接复活。`addendum.md` 的 Brownfield Ledger 和“已覆盖的旧方案”完整表达了这些覆盖关系。

剩余风险不是旧方案仍被当作目标，而是五处新契约尚未形成单一可实现语义。

## Gap 1 - 在途 `send` 能否跨重连存在两种表述（Critical）

### 证据

- `prd.md` FR-19 要求主动端 Transport 处理“意外断线恢复和同一次交付预算内的重发”，容易被理解为同一个 `send` 可以在新连接继续。
- FR-27 的假设又要求旧 connection generation 的所有未完成 `send` 在断开时失败，自动重连只服务之后的新消息。
- `addendum.md` §3.2、§6 明确采用后者：先 reject 旧 generation 全部未完成 `send`，不实现跨 Socket resume。
- 旧 Architecture Spine 则关闭自动重连，无法作为新语义的裁决来源。

### 影响

这会直接改变 `send()` Promise 的最终性、是否可能重复交付、Transport 队列在断线时的清理范围，以及 Socket.IO offline buffer 的抑制方式。两种语义不能同时作为验收标准。

### 收口要求

PRD 必须明确选择以下之一：

1. **当前附录方向：** 重传只发生在一个有效底层连接内；连接一旦结束，旧 generation 所有未完成 `send` 失败，重连只承载之后的新 `send`。
2. **跨连接续传：** 同一 `send` 可以跨 Socket 存活；这将要求 logical connection ID、resume handshake、跨连接 ACK offset、Server 状态保留和去重，并与当前非目标冲突。

按现有附录和风险护栏，第一项是当前一致性更高的解释；Architecture Update 不应自行猜测。

## Gap 2 - Session 跨连接连续性、`session.open` 与 heartbeat 尚未闭合（Critical）

### 证据

- PRD FR-14 要求 Session 完全不消费 Transport lifecycle，已交付 Pending Request 在断线后继续等待 Response timeout。
- FR-5 又假设 Client 在每个新 Socket generation 恰好执行一次 `session.open`。
- PRD FR-12 保留 Ping/Pong，开放问题 3 将 heartbeat failure 的传播留给 Architecture。
- 旧 Architecture Spine / `docs/architecture.md` 把 generation、断线 pending 清理、heartbeat timeout 后关闭 Session/Transport全部放在 Session；这些决定已经被覆盖，不能直接复用。

### 影响

Architecture 仍无法回答以下实现问题：

- 重连后 Client 复用同一个 Session，还是创建新 Session；
- 若复用，requestId 的不可复用域是整个 Session 生命周期还是连接 generation；
- 若创建新 Session，旧 Pending Request 是立即由 dispose 拒绝，还是仍按 PRD 等待 timeout；
- reconnect/open 期间新 Request 是 `not-ready` 失败还是允许 Transport 接收；
- heartbeat timeout 只形成 Session health failure，还是由 Client 再决定关闭/重启 Transport；
- 旧连接启动的异步 inbound handler 完成后，如何避免 Response 被发送到新连接。

### 收口要求

PRD 至少要固定可观察结果；Architecture 再固定对象生命周期和算法。尤其要保持“Session 不感知 Transport disconnect”与“旧异步工作不能写入错误对端”同时成立，不能把旧 generation 状态机悄悄放回 Session。

## Gap 3 - 新的双能力面方向正确，但数据面所有权契约不完整（High）

### 证据

- `addendum.md` §2 已正确把旧 `receive(TransportEvent)` 拆为 `SessionTransportPort.send/receive(bytes)` 与 `ManagedTransport.state/connect/disconnect/on`。
- 旧 Architecture Spine AD-6、Public Contracts、Transport/SDK state machine 仍规定 Session 消费 message/state/error 联合事件，是必须替换的旧契约。
- 原 source extracts 还保留了以下仍有效的可靠性细节：一个 receive stream 只能由一个 Session 拥有、注册/取消订阅规则、listener 异常隔离、入站字节与内部可变 buffer 隔离。
- 当前 PRD 只对 lifecycle listener 写了异常隔离，没有固定 Session data listener 的单一所有权和字节快照保证。

### 影响

若一个 Transport 被两个 Session 同时消费，Response/Request 会被重复解码和错误关联；若交付可变 buffer，异步消费可能读到被 Transport 后续复用的内容。Server 组合根也需要在不让 Session消费 lifecycle 的前提下独立清理 accepted Socket 资源。

### 收口要求

Architecture Update 必须给出唯一 TypeScript 契约，并显式裁决：

- 每个 Transport data receive stream 的 Session 所有权；
- `receive` 注册时机、取消订阅和 listener 隔离；
- 字节所有权/复制规则；
- lifecycle 快照与订阅的竞态、事件顺序及重入；
- `subscribe -> receive + lifecycle on` 的原子迁移，不保留运行时双接口探测。

## Gap 4 - “独立发布”与现有 package spine 仍直接冲突（High）

### 证据

- PRD FR-29 要求 SDK、Session 能力和具体 Transport 独立安装、版本化和发布。
- `addendum.md` §9 已正确指出继续使用单一 `@remote-copy/protocol/implementations` subpath 不足以自动满足该目标。
- 现有 Architecture Spine AD-13、Source Ownership、`docs/architecture.md` 和 `docs/implementation-plan.md` 仍将 Codec、Session、Socket.IO Client/Server Transport 全部放入 `packages/protocol` 的 implementations 入口；SDK 还默认组合具体 Socket.IO Transport。

### 影响

在 package 名、依赖方向和 peer dependency 未定前，无法安全设计 exports、避免 SDK bundle 隐式加载 Socket.IO，也无法把 Story 切成可独立发布的工作单元。

### 收口要求

Architecture Update 必须固定：definitions/Codec/Session 的物理归属、Socket.IO Client/Server Transport 是同包还是分包、SDK 的 runtime/peer dependencies、root/subpath exports、版本兼容矩阵和迁移顺序。`docs/architecture.md`、`docs/implementation-plan.md`、README、exports tests 与 `AGENTS.md` 必须同步更新。

## Gap 5 - PRD/附录边界与旧决策保留清单仍需一次整理（Medium）

### 技术 HOW 位置

正文整体已经把 28-byte DATA、8-byte ACK、Go-Back-N 公式和重传计时放在 `addendum.md`，方向正确。但以下正文验收仍混入具体机制：

- FR-17 的“发送窗口跨消息”；
- FR-22 对非法 frame、重组无进展、序号耗尽的具体 fatal 分类；
- FR-25 的 DATA/ACK 丢失组合和 ACK 绕过窗口；
- FR-27 的 frame/message/ACK/window/reassembly 内部状态。

这些内容要么明确标注为仓库既有、不可破坏的 Socket.IO 互操作约束，要么下沉到附录，正文只保留“并发排队有效利用容量、可恢复丢失不重复交付、新连接隔离旧事件”的能力结果。否则 PRD §0 声称的“正文只约束调用方行为”与实际范围不完全一致。

### 仍有效但不得随旧生命周期一起删除

Architecture Update 需要单独列出 carry-forward 决策，避免整段替换旧 Spine 时误删：

- Codec 不可信输入边界与 method-specific result 校验；
- Transport Delivery、协议 Response、Operation terminal 三种完成语义；
- requestId、heartbeatId、operationId、Transport 序号的命名空间隔离；
- Response/Notification 可能早于本地 send resolve 的 first-wins 行为；
- `operation.status` revision 去重及公共四态；
- Server 每个 accepted Socket 创建对端组合、`session.open` gate；
- 如仍在本重构范围，旧 Spine AD-14/AD-17/AD-18 的 OperationStore、Response 前 Notification 和 Server operationId 幂等安全规则。

PRD FR-31 只保留了 operation 四态、revision 和完成语义，不能被解释为自动撤销旧 Spine 更强的 operation 安全规则；若这些规则移出本 PRD，也应在 Architecture Update 标为 retained/out-of-scope，而不是消失。

## 已正确标记覆盖的旧决策

以下覆盖关系在当前 `addendum.md` §10、§12 中已经表达充分，无需再次写回 PRD：

| 旧基线 | 最新目标 |
| --- | --- |
| SDK `createTransport(target)` / 每次 connect 新建 Transport + Session | 调用者预创建可复用 Transport 实例并注入 Client |
| `client.connect(url)` | 连接目标封装在 Transport；Client 目标 API 为无 URL connect |
| Session `connect/disconnect`、读取 state、消费 lifecycle union | Session 只消费完整消息 send/receive，并拥有独立 dispose |
| Session 遇 disconnect/fatal 立即清空所有 pending | 未完成 send 由 Transport reject；已交付 Request 等自己的 Response timeout |
| Socket.IO Client `reconnection:false`，SDK 显式重建 | 主动 Transport 内部有限恢复，显式 disconnect 抑制恢复 |
| Session 等待前序 Request | 并发 Request 立即交给 Transport，队列和背压只在 Transport |
| reject 后连接恢复继续旧消息 | reject 为永久终态，后续连接只服务允许的新消息 |

## Architecture Update 替换范围

更新 Architecture Spine 时至少要逐项重写而不是局部补丁：

- AD-3 中 Session connection generation 所有权；
- AD-4 中 disconnect/generation replacement 作为 Pending Request terminal signal；
- AD-6 的 message/state/error 联合 `receive`；
- AD-9 的每次 SDK connect 新建 Transport/Session、Session 先绑定再 connect；
- AD-12 的 disconnect/fatal 立即清空 Session pending；
- AD-13 的 SDK 默认组合具体 Socket.IO Transport；
- Public Contracts、State Ownership、Session/Transport 状态机、Request Algorithm、Error Matrix、Source Ownership、Brownfield Ledger 与 Deferred 中对应描述；
- `docs/architecture.md` §2、§7、§9、§10、§14-16，以及 `docs/implementation-plan.md` 的 Session、Transport、SDK、测试步骤。

现有 Spine 在上述位置与新 PRD 已发生实质冲突。Architecture Update 完成前，应避免继续把它的 `status: final` 理解为当前可实施真相。
