---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-remote-copy-2026-07-16/prd.md
  - _bmad-output/planning-artifacts/prds/prd-remote-copy-2026-07-16/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-remote-copy-2026-07-16/ARCHITECTURE-SPINE.md
  - _bmad-output/specs/spec-remote-copy/SPEC.md
  - _bmad-output/specs/spec-remote-copy/acceptance-contract.md
  - AGENTS.md
---

# remote-copy - Epic Breakdown

## Overview

本文档为 remote-copy 的完整 Epic 与 Story 拆分入口，将最终 PRD、Architecture、SPEC、验收契约和仓库约束整理为可追踪、可按序实施的需求。每个 Story 都保持依赖向后、完成后全仓绿色，并遵循“先建立目标边界、再迁移消费者、最后删除旧接口”的 brownfield 迁移顺序。

## Requirements Inventory

### Functional Requirements

FR-1: Browser 调用者能够创建并配置 Client Transport 实例后注入 `RemoteInputClient`；SDK 不默认导入或选择具体 Transport，替换 Transport 不改变应用 API。

FR-2: Client 提供显式连接、显式关闭、`inputText`、Operation 查询以及状态和 Notification 订阅；所有业务报文只能经 Session 发送。

FR-3: Browser 只直接消费 SDK 与选定的 Client Transport，Server 只消费 Session 与 Server Transport；两端共享同一协议 definitions、Codec 和 Session 契约。

FR-4: Client 可通过 Managed Transport 的同步快照和生命周期订阅编排连接、ready 与 UI 状态，但不得把 Transport 状态当作单次发送成功证明或绕过 Session 发送。

FR-5: Client 仅在当前 Connection Generation 可交换完整消息且 `session.open` 成功后进入 ready；`connect()` 只在 ready 后完成，并隔离旧 generation 的迟到结果。

FR-6: 同一 Client 和可复用 Client Transport 在显式 `disconnect()` 后能够再次 `connect()`；显式关闭停止自动恢复，连接、关闭和恢复竞态不得污染当前状态。

FR-7: Session 接受类型化 `method + body`，创建不复用的 `requestId`，并以经过 method schema 校验的类型化结果或保留协议错误信息的结构化失败完成请求。

FR-8: Session 在调用 Transport `send()` 前登记 Pending Request，使早于本地 send Promise 完成的 Response 仍能正确关联。

FR-9: Session 不串行化并发 Request 或实现发送队列；后续 Request 立即独立登记并提交 Transport，Response 可逆序且只完成匹配的 `requestId`。

FR-10: 每个 Pending Request 在对应 Transport Delivery 成功后启动独立 Response Timeout；默认 10 秒、公共配置为 1000 至 120000 毫秒，超时只终结该请求且迟到结果不得复活它。

FR-11: Transport send failure 只终结仍 pending 的关联 Request并保留原始 cause；匹配 Response 已先完成时，迟到的 send failure 不得反转结果，Session 不隐式重试。

FR-12: Session 支持 Request、成功/失败 Response、Notification、Ping/Pong、类型化入站 handler、诊断错误和显式 heartbeat；重复、未知、迟到或 handler 异常均按冻结的协议错误规则处理。

FR-13: Session 必须通过 MessageCodec 编码出站消息并对入站 UTF-8、JSON、版本、envelope、body、ProtocolError 和成功 result 进行运行时校验；非法输入不得进入 handler，Transport 不解析业务 JSON。

FR-14: Session 只依赖完整消息 `send/receive` 数据面，独占一个 receive stream，并提供幂等 `dispose()` 释放 listener、pending、handler callback 和 timer；它不读取或控制 Transport 生命周期。

FR-15: Transport 的数据面只接受和交付完整 `Uint8Array` 消息，每次 `send()` 对应独立 Promise；空消息和最大消息行为确定，交付字节在 callback 后不得被修改或复用。

FR-16: Transport 在单个有效 Connection Generation 内提供双向可靠、有序、保留消息边界且至多一次上行交付的通道，不暴露 frame、ACK 或重试细节。

FR-17: Transport 统一承接多个并发 send 的排队、背压、提交顺序和跨消息调度；每个调用独立完成，容量超限时只拒绝新调用且不提供公共 `sendBatch`。

FR-18: Transport `send()` 仅在对端 Transport 确认整条消息后成功；Transport Delivery、协议 Response 和长期 Operation completion 是三个独立完成语义。

FR-19: 主动 Client Transport 独占初次建链和有界自动恢复；非 connected 状态的新 send 立即失败，未完成 send 不跨 Connection Generation 重放，显式 disconnect 停止恢复并允许后续显式重连。

FR-20: ClientTransport 提供连接、关闭、同步状态、无丢失生命周期订阅和单调 Connection Generation；accepted ServerTransport 提供观察和关闭但不主动 connect，Session 不消费这些能力。

FR-21: Transport send rejection 是本地永久终态，之后不得再发送该消息的新 DATA；失败按是否可能已有 DATA 离开本地区分 `not-delivered` 与 `delivery-unknown`，后续恢复不得复活旧调用。

FR-22: Transport 区分 call-local 与 connection-generation-fatal 失败；资源拒绝只影响新调用，非法帧、重组无进展、重传或序号耗尽必须终结当前 generation 并清理全部相关资源。

FR-23: Transport 对单消息、队列条数、队列总字节、连接/交付尝试、重组和排队时间设置有限上限，并以结构化错误保留诊断 cause。

FR-24: 当前版本提供可双向并发互操作的 Socket.IO Client Transport 与 accepted Socket Server Transport；两端满足同一完整消息和失败契约且不解析业务 JSON。

FR-25: Socket.IO Transport 对大消息透明拆分和合法重组，DATA 窗口可跨消息；丢失、重复或乱序在可恢复范围内不得造成部分、重复或乱序的完整消息交付。

FR-26: Socket.IO 双端只通过单一二进制 `protocol:frame` 和相同 wire version 互操作；配置不兼容时确定性失败，Socket.IO 默认离线缓冲、event ACK 与 connection recovery 不得替代产品保证。

FR-27: 每个新 Socket.IO Connection Generation 隔离序号、消息、窗口、ACK、重组和回调；旧 generation 的未完成 send 必须终结，旧 Socket 事件不得污染或复活当前 generation。

FR-28: Client Transport 可主动建链和恢复；Server Transport 只包装当前 accepted Socket，断开后不找回旧 Socket，新 Client Socket 由 Server 组合为新的 Transport 与 Session，并重新要求 `session.open`。

FR-29: Protocol、Session、Socket.IO Transport 与 SDK 能够按冻结的四包边界独立安装、版本化和发布；Browser 和 Server 的依赖闭包不得引入对方或未选择的运行时。

FR-30: `@remote-copy/protocol` 是应用协议唯一事实源；root/definitions 只导出类型、常量和 ports，运行时实现从明确入口导入，所有公开契约使用严格 TypeScript 判别联合。

FR-31: 分层迁移保留长期 Operation 语义：`operationId` 在发送前创建或复用，失败携带 ID；公共状态、严格递增 revision、合法迁移、terminal 不回退及 Transport ACK/Response 不冒充完成均保持一致。

FR-32: definitions、实现、SDK、Server、Browser、测试、exports 和中文文档必须以一次原子 breaking migration 收敛到新 API，并删除旧 factory、`sendInput`、Session lifecycle、event-union subscribe、alias、adapter 和双接口探测。

### NonFunctional Requirements

NFR-1: 每个 Request 与每个 Transport `send()` 必须恰好最多完成一次；任何迟到 Promise、timer、Response、Pong 或 Socket callback 都不得反转已完成结果。

NFR-2: 并发 Request 必须始终按 `requestId` 正确关联，未知、重复和迟到 Response 不得串配其他调用。

NFR-3: Transport Message 不得出现部分交付、合并、提交顺序倒置或重复上行交付，并必须在 callback 后保持交付字节稳定。

NFR-4: send rejection 后该消息新增本地 DATA frame 数必须为零；`not-delivered | delivery-unknown` 必须准确表达本地可判定程度而非承诺远端结果。

NFR-5: Session 不得通过读取 Transport state 或 lifecycle event 判断单次发送成败，也不得复制 Transport 的队列、连接或恢复状态机。

NFR-6: Session 默认最多保留 128 个 Pending Request，每个 Request 均有独立有限 Response deadline；新增超限 Request 只能局部失败。

NFR-7: 默认 `responseTimeoutMs=10000`、heartbeat interval 15 秒、Pong timeout 10 秒；所有可配置 timeout/deadline 必须是有限正整数、单位为毫秒，并在构造时校验。

NFR-8: Transport 默认单条完整消息不超过 256 KiB，发送队列不超过 128 条且 queued/awaiting-ACK 总计不超过 4 MiB。

NFR-9: Transport 的初连、恢复、排队、ACK/retry 和重组等待都必须有可测试的有限预算，任何已接受的 send 均不得永久 pending。

NFR-10: 所有 timeout、失败、disconnect、generation 终止和 dispose 路径均不得遗留 listener、未决 Promise、Pending Request、发送队列、窗口、重组缓存或 timer。

NFR-11: Session/Transport 公共契约和 message-only fake 必须在不引入 React、DOM、Node HTTP、剪贴板或下游输入执行类型的 fixture 中完成类型检查。

NFR-12: 新 Transport 可在不修改 Session Request/Response 逻辑和 Client 应用 API 的情况下接入；当前只通过 Socket.IO 实现与测试替身证明，不实现或模拟 Bluetooth/WebSocket。

NFR-13: Client 必须以稳定结构字段区分连接失败、`not-delivered`、`delivery-unknown`、Response Timeout、Heartbeat Timeout、远端 ProtocolError、校验失败与 Operation failure；ID 创建后的输入失败必须携带 `operationId`。

NFR-14: 跨层错误必须保留原始 cause 或等价诊断，但公共控制流不得依赖错误 message、跨包 `instanceof` 或 Socket.IO 专属文本。

NFR-15: lifecycle snapshot/event 只用于生命周期和诊断，每个 `send()` Promise 始终是交付结果的唯一权威。

NFR-16: Protocol/Codec 测试必须覆盖全部消息类型、成功/失败 Response、method result 校验、Notification、Ping/Pong、非法 UTF-8/JSON/version/envelope/body 及 exports 隔离。

NFR-17: Session 测试必须使用 message-only fake 覆盖 pending-before-send、并发/逆序/早到 Response、Delivery 后计时、first-wins、ID 不复用、重复 Request、handler 容量、heartbeat run 隔离、订阅与 dispose。

NFR-18: Transport 测试必须覆盖精确 DATA/ACK wire、空/单/多分片、双向边界和顺序、跨消息窗口、累计 ACK、ACK bypass、丢失/重复/越序、重传、恢复、失败最终性、资源上限、序号耗尽和非法帧清理。

NFR-19: SDK 测试必须覆盖实例注入、bundle 不含具体 Transport、connect single-flight、open/ready gate、每代一次 open、自动恢复、显式周期重建 Session、错误/operationId 恢复、订阅和 strict revision。

NFR-20: Server 测试必须覆盖 accepted Transport 无 connect、`session.open` gate、类型化 handler/Notification、Transport 终止后的 Session dispose、进程级 operationId 幂等和 subscriber rebind。

NFR-21: 跨 workspace 交付必须通过 `pnpm test:protocol`、`pnpm test:sdk`、`pnpm test:server`、`pnpm check` 和 `pnpm build`；真实 Socket.IO 自动联调只发送 `session.open`，不得发送非空 `input.submit`。

NFR-22: 当前运行边界仅为受信任本机或 LAN；库不得默认记录 input text、协议 body 或 frame payload，公网暴露前必须另行评审 TLS、认证、Origin allowlist、rate limiting 与审计。

NFR-23: 全部实现必须使用严格 TypeScript、判别联合和运行时 type guard；生成产物 `dist/`、`.turbo/`、`public/` 不得手工编辑。

### Additional Requirements

- AR-1: 本项目是既有 pnpm workspace/Turborepo brownfield 迁移，不创建 starter template；实施必须保留已有修改，并按目标 source ownership 迁移现有代码。
- AR-2: 公共包固定为 `@remote-copy/protocol`、`@remote-copy/session`、`@remote-copy/transport-socket-io` 和 `@remote-copy/sdk`，目标目录分别位于 `packages/protocol`、`packages/session`、`packages/transport-socket-io` 和 `packages/sdk`。
- AR-3: `@remote-copy/protocol` root 与 `/definitions` 只导出类型、常量和 ports；`/implementations` 只导出 validation、`JsonMessageCodec` 和结构化 guards，不再包含 Session 或具体 Transport。
- AR-4: `@remote-copy/session` root 导出 `ProtocolSession`、`ProtocolRequestError`、Session errors/guards，并从 protocol 重导出 Server handler 所需协议类型；`@remote-copy/transport-socket-io` 只公开 `./client` 与 `./server`，共享 wire/controller 保持私有且两个子路径不得交叉 import；SDK root 不导出内部 store。
- AR-5: 内部依赖固定为 SDK -> protocol + session、Session -> protocol、Socket.IO Transport -> protocol；使用普通 `dependencies` 和 `workspace:^`，发布后映射同 major caret，不使用内部 peerDependencies。
- AR-6: 同 major minor/patch 必须与该 major 最低支持的 envelope、method schema 和 DATA/ACK wire 双向兼容；breaking schema/wire 同时提升 package major 与协议或 frame version，未知版本确定性失败，CI 使用 golden fixtures 验证。
- AR-7: 目标工具链固定 TypeScript 7.0.2、Node.js 24.15.0、pnpm 10.0.0、Turborepo 2.10.4、Socket.IO 4.8.3；新增单一 Node pin 并将 root `engines.node` 固定为 `>=24.15.0 <25`。
- AR-8: 公共端口名称固定为 `MessageTransport`、`ClientTransport`、`ServerTransport`、`MessageCodec`、`ProtocolSessionContract`；实现名称固定为 `ProtocolSession`、`JsonMessageCodec`、`SocketIoClientTransport`、`SocketIoServerTransport`。
- AR-9: `MessageTransport` 恰好只有 `send(message)` 与 message-only `receive(listener)`；`ClientTransport` 增加 `kind/state/getLifecycleSnapshot/subscribeLifecycle/connect/disconnect`，`ServerTransport` 增加相同观察与关闭能力但没有 `connect`。
- AR-10: Transport 状态固定为 `idle | connecting | connected | reconnecting | disconnected | error`；Client 状态固定为 `idle | connecting | opening | ready | reconnecting | disconnecting | disconnected | error`，不得用含混的 Client `connected` 代替 `opening/ready`。
- AR-11: lifecycle 订阅同步首发 immutable 当前快照，状态先写后发布；connected generation 从 1 开始单调不复用，listener 按事件开始时的注册顺序快照调用、异常隔离、取消幂等。
- AR-12: ClientTransport connect/disconnect 通过 single-flight 与 FIFO transition queue 线性化；显式 stop intent 后新 send 立即失败，旧 callback 由 lifecycle epoch 丢弃，connect/disconnect listener 重入不得破坏状态。
- AR-13: 每个显式 Client connection cycle 创建一个新 Session；同一 cycle 的自动 Transport generations 复用该 Session 与 receiver。Client 必须先安装 Notification/error 订阅再 connect/open，所有异步写入同时匹配 `clientCycleId + generation`。
- AR-14: `RemoteInputClient` API 固定为构造注入 Transport、`connect`、`disconnect`、`inputText`、`getState`、`subscribeState`、`subscribeNotification`、`getOperationStatus`、`refreshOperationStatus` 和 `subscribeOperation`。
- AR-15: Client readiness 总期限默认 30 秒，初次 Transport connect 最多 10 秒；每代只执行一次 `session.open`，失败必须按 generation-scope/call-scope cause 规则关闭或等待恢复，旧 open 结果不得写入当前 cycle。
- AR-16: 主动 Transport 恢复最多 3 次、总预算 30 秒，尝试前固定延迟 `[0, 1000, 3000]` ms、单次最多 10 秒；每代创建全新 Socket 与 Manager，禁用 Socket.IO 内建 reconnection、event retries、offline send buffer 和 connection-state recovery。
- AR-17: `ProtocolSession` API 固定为 `request/notify/handleRequest/subscribeNotification/subscribeError/startHeartbeat/stopHeartbeat/dispose`；配置名固定为 `responseTimeoutMs/maxPendingRequests/maxConcurrentHandlers/heartbeatIntervalMs/pongTimeoutMs`，默认最多 128 个并发入站 handler，超限返回可重试 `request.capacity-exhausted`。
- AR-18: Pending Request 采用 first-terminal-wins；active/保留期内的重复入站 Request 返回 `request.duplicate`。完成 tombstone 默认最多 1024 条、最长 10 分钟，先到为准，满时淘汰最旧 tombstone 且不得淘汰仍执行的 handler 记录。
- AR-19: Heartbeat 不隐式启动；Pong timer 只在 Ping Delivery 后启动。`stopHeartbeat()` 通过 run epoch 使旧 callback/timer/Pong 失效；匹配当前 cycle/generation 的 timeout 才由 Client 串行执行 `disconnect() -> connect()`，Server 则关闭 accepted Transport。
- AR-20: 每个被 Transport admission 接受的 send 必须连同队列等待在内于有限时间内 settle；实现可从有界队列/progress/retry 推导有限上界或使用显式有限 queue deadline，并以可控时钟覆盖慢进度、停止 ACK、关闭和超限。
- AR-21: Socket.IO DATA 使用 28-byte 大端 header：magic `0x5243`、version 1、kind 1、`frameSeq/messageId/chunkIndex/chunkCount/totalMessageBytes/payloadBytes` 后接 payload；ACK 固定 8 bytes、kind 2、携带 `nextExpectedFrameSeq`，绕过 DATA window 且不再被 ACK。
- AR-22: 每方向每 generation 的 `frameSeq/messageId/nextExpectedFrameSeq` 从 0 连续递增且不回绕；DATA 最大序号 `0xfffffffe`，`0xffffffff` 只作最终累计 ACK；默认 chunk 16 KiB、窗口 8、ACK timeout 2 秒、最多 3 轮重传、重组无进展 10 秒。
- AR-23: 接收端仅接纳 exact-next 且 canonical 的 DATA；重复/越序 DATA 不接纳 payload 并回复当前累计 ACK。重复/回退 ACK 不推进或重置 deadline；future ACK、非 canonical metadata、长度矛盾或超限 frame 终结 generation。
- AR-24: generation-fatal 清理必须原子清空队列、窗口、重组状态和 timer，并逐 send 按 DATA 是否可能离开本地分类 `not-delivered | delivery-unknown`；旧 Socket listener、callback 和 sendBuffer 不得复活已失败消息。
- AR-25: SDK OperationStore 只接受严格更高 revision 和合法状态迁移；最多 1000 条，优先淘汰最旧 terminal，无法淘汰时拒绝未知 operation 并发布 `operation-cache-full`。自动恢复保留缓存，新的显式 connection cycle 清空缓存。
- AR-26: Server 在 `session.open` 前对 `input.submit/operation.get` 返回 `session.required`；同连接重复 open 幂等。Server 每 accepted Socket 同步创建一个 `ServerTransport + ProtocolSession`，Transport 终止时 dispose Session 并解绑 subscriber。
- AR-27: Server 进程内 operationId 全局幂等：相同 ID+text 复用、相同 ID+不同 text conflict；claim、text hash、subscriber 和 `accepted/revision=1` 在无 await 临界区完成，job 断线后继续且新 Session 可查询/重新绑定。
- AR-28: Server 最多保留 1000 个 status snapshot，优先淘汰最旧 terminal 且不淘汰 active；另保留最多 100000 个 `operationId + textHash` tombstone。淘汰状态返回 `operation.expired`，tombstone 满后新 ID 返回 `operation.capacity-exhausted`，重启开启新幂等域。
- AR-29: 结构化错误契约固定为 `TransportLifecycleError`、`TransportSendError`、`SessionRequestError`、`SessionDiagnosticError`、`InputTextError`、`ClientConnectError` 和 `ClientDiagnosticError`；跨层依靠 `kind/code/scope/delivery` guards，包装时保留 cause。
- AR-30: 诊断 cause/stack 只用于显式本地开发诊断，不进入协议、默认 UI、持久化或自动日志；库不直接 `console`，组合根日志只记录 code、ID、generation、大小和时序。
- AR-31: 原子迁移顺序固定为先建立 protocol ports/error 与新 package/测试入口，再迁移共享 Transport core、Session、SDK、Server/Browser，最后收敛 tests/exports/build/docs/`AGENTS.md` 并删除所有旧 API。
- AR-32: root `test:protocol` 必须聚合 protocol/session/transport package tests，并增加 golden fixtures、exports 隔离、Browser bundle 与 Server import 边界检查；输入成功路径使用无 OS 副作用的 fake/direct handler。
- AR-33: 依赖链必须保持 `RemoteInputClient -> ProtocolSession -> MessageCodec -> MessageTransport`，每层只能修改自己拥有的状态；禁止新增跨层 `Channel`、重复发送队列、重复连接/ready 状态机或让 Session 接触 frame/chunk/window/ACK。
- AR-34: 当前 `AGENTS.md` 中“Session/Transport 位于 protocol implementations”及“SDK 从 protocol 获取 Socket.IO Transport”只代表 brownfield 归属；目标必须采用 Architecture AD-13 的四包边界，并在原子迁移中同步改写这些仓库规则。
- AR-35: 任何应用协议变更必须同步 TypeScript definitions、运行时 schema/Codec、Session、SDK、Server 和测试；禁止使用 `JSON.parse(...) as ProtocolMessage` 或等价类型断言绕过不可信输入校验。
- AR-36: Socket.IO 空消息必须编码为一个零 payload DATA；`chunkCount=max(1,ceil(totalMessageBytes/chunkPayloadBytes))`，非末片 payload 必须等于 chunk 大小，末片必须精确等于剩余字节。只有累计 ACK 或接收端期望序号严格推进才算 progress 并重置相应 deadline。
- AR-37: Server Operation 状态更新必须在一个同步临界区内递增 revision、替换 snapshot 并取得 subscriber 快照，再在临界区外通知；状态读取、订阅和重连 rebind 不得漏掉更新。
- AR-38: `client.connect()` 只能以 `ClientConnectError` 的 `connect-timeout | transport-failed | session-open-failed | recovery-exhausted | connect-cancelled` 失败；显式取消最终必须为 Client `disconnected` 且 `error=null`，不得向调用者泄漏 Socket.IO 原始错误。
- AR-39: `InputTextError` 必须包含稳定 `kind/code/operationId/cause`；只有 operationId 创建前允许 `operationId=null`，创建后的 transport、response、remote、validation、capacity 或 dispose 失败都必须保留该 ID。
- AR-40: 成功 Response body 在匹配 Pending Request 前保持 `unknown`，匹配后按原始 method 的 result schema 校验；未知、重复或迟到 Response/Pong 只发布 diagnostic，不得完成任何当前调用。

### UX Design Requirements

不适用：未发现或纳入 UX 设计契约；本次范围明确不包含 UI 重设计。

### FR Coverage Map

FR-1: Epic 2 - SDK 完成注入式 Client core，随后 Browser 原子切换到可替换 Transport。
FR-2: Epic 2 - Client API 在 SDK core 完成，并由 Browser 最终切换消费。
FR-3: Epic 2 - Browser 与 Server 分别按独立消费路径完成组合。
FR-4: Epic 2 - Client 观察 Transport 生命周期但所有业务报文仍经过 Session。
FR-5: Epic 2 - `connect()` 仅在当前 generation 完成 `session.open` 并 ready 后成功。
FR-6: Epic 2 - 同一 Client/Transport 显式关闭后可再次连接且竞态隔离。
FR-7: Epic 1 - Session 提供类型化 Request/Response 与结构化错误。
FR-8: Epic 1 - Pending Request 在 Transport send 前登记以支持早到 Response。
FR-9: Epic 1 - Session 立即提交并发 Request 且按 requestId 独立关联。
FR-10: Epic 1 - 每个 Request 在 Transport Delivery 后启动独立 Response Timeout。
FR-11: Epic 1 - Transport send failure 只完成关联 Request 并保留 cause。
FR-12: Epic 1 - Session 处理全部协议消息、handler、heartbeat 和异常输入。
FR-13: Epic 1 - Codec 对全部入站协议字节执行强制运行时校验。
FR-14: Epic 1 - Session 只依赖完整消息数据面并可幂等释放自身资源。
FR-15: Epic 1 - Transport 只接受和交付具有稳定所有权的完整字节消息。
FR-16: Epic 1 - Transport 提供可靠、有序、保留边界且至多一次上行交付。
FR-17: Epic 1 - Transport 统一管理并发发送、队列、背压和顺序。
FR-18: Epic 1 - send 只在整条消息被 Transport ACK 后成功并与上层完成语义分离。
FR-19: Epic 1 - 主动 Transport 独占有界自动恢复且不跨 generation 重放。
FR-20: Epic 1 - Client/Server Transport 提供角色化生命周期能力与 generation。
FR-21: Epic 1 - send rejection 具有本地最终性并区分 Delivery outcome。
FR-22: Epic 1 - Transport 区分 call-local 与 generation-fatal 失败并完整清理。
FR-23: Epic 1 - Transport 的消息、队列、尝试、重组和等待资源全部有界。
FR-24: Epic 1 与 Epic 2 - Socket.IO 双端可靠实现并由 Server 组合根完成真实互操作。
FR-25: Epic 1 - Socket.IO Transport 透明拆分、跨消息调度和合法重组。
FR-26: Epic 1 - 双端只使用固定二进制 `protocol:frame` wire 契约。
FR-27: Epic 1 - 每个 Socket.IO Connection Generation 完整隔离旧可靠传输状态。
FR-28: Epic 1 与 Epic 2 - 主动 Client 与 accepted Server Transport 遵守不对称生命周期并完成应用组合。
FR-29: Epic 2 - Protocol、Session、Socket.IO Transport 与 SDK 可独立消费和发布。
FR-30: Epic 1 与 Epic 2 - Protocol 保持协议唯一事实源并最终隔离定义与运行时入口。
FR-31: Epic 2 - SDK、Server Registry 与 Browser 消费路径共同保持长期 Operation 语义。
FR-32: Epic 2 - 全部调用方、exports、测试和文档原子迁移并删除旧接口。

## Epic List

### Epic 1: 集成者可建立可信的 Socket.IO 双向会话

SDK 与 Server 集成者能够使用独立 Protocol、Session 与 Socket.IO Transport，在完整消息通道上完成经过运行时校验的并发 Request/Response、Notification、Heartbeat，以及可靠、有界、可恢复的字节消息交付。

**FRs covered:** FR-7 至 FR-28、FR-30

### Epic 2: 产品集成者可迁移并使用可插拔远程操作链路

SDK、Server 与 Browser 集成者能够按安全顺序迁移到目标四包链路，最终通过注入式 `RemoteInputClient` 完成 ready、输入、Operation 追踪和恢复，并独立安装和验证各包。

**FRs covered:** FR-1 至 FR-6、FR-24、FR-28、FR-29、FR-30、FR-31、FR-32

## Epic 1: 集成者可建立可信的 Socket.IO 双向会话

SDK 与 Server 集成者能够使用独立 Protocol、Session 与 Socket.IO Transport，在完整消息通道上完成经过运行时校验的并发 Request/Response、Notification、Heartbeat，以及可靠、有界、可恢复的字节消息交付。

### Story 1.1: 消费可移植且唯一事实源的协议契约与 Codec

As a SDK、Server 或 Transport 集成者,
I want 从隔离的公开入口导入统一协议定义、分层端口和经过运行时校验的 Codec,
So that 我能够在 Browser、Server 与测试替身中安全交换协议消息，而不复制 schema 或信任原始字节.

**FRs:** FR-7、FR-12、FR-13、FR-30

**Acceptance Criteria:**

**Given** brownfield 调用方仍使用现有 protocol runtime exports
**When** 本 Story 增量建立目标 protocol definitions 与 Codec
**Then** root/definitions 的新增目标面只包含协议类型、常量、Codec/Transport ports 和公共错误结构，implementations 的新增目标面只包含 validation、type guards 与 `JsonMessageCodec`
**And** 本 Story 不新增 alias、adapter 或双接口探测；既有 runtime 暂留以保持当前调用方全仓绿色，并只在所有消费者迁移后的最终原子切换 Story 中删除。

**Given** Session 与 Socket.IO Transport runtime 将在后续实现
**When** 本 Story 建立目标 workspace 骨架
**Then** 同步创建 `@remote-copy/session`、`@remote-copy/transport-socket-io` 的 manifests、exports、source/test 入口和可独立执行的初始边界 fixture
**And** 从本 Story 起 root `test:protocol` 依次聚合 protocol、session、transport-socket-io 测试及 golden/exports/Browser bundle gates；所有后续迁移都必须在该门禁下保持绿色。

**Given** 目标导出隔离 fixture
**When** 直接针对新增 definitions 与 implementations 入口编译
**Then** 新代码不得从 definitions 导入 `ProtocolSession` 或具体 Transport，也不得从 implementations 新增 Session、Socket.IO、SDK 或 Server runtime 依赖
**And** 最终 package export map 的排他性与既有 runtime 移除由原子迁移 Story 验证，前序 Story 不提前破坏旧消费者。

**Given** 协议定义入口
**When** TypeScript 编译 Request、Response、Notification、Ping 与 Pong
**Then** 它们形成严格判别联合，并分别使用 `requestId`、`operationId` 和 `heartbeatId`
**And** method、result 与 Notification body 只能来自唯一的类型映射。

**Given** 任一合法协议消息，包括全部当前 method 和 Notification
**When** 使用 `JsonMessageCodec` 编码后再解码
**Then** 返回语义等价的完整消息，并遵守 UTF-8 与 256 KiB 上限
**And** Transport 或其他 package 不得重新定义协议 schema。

**Given** 非法 UTF-8、JSON、版本、kind、envelope、标识符、Request body、Notification body、ProtocolError 或超限消息
**When** Codec 解码
**Then** 必须以结构化验证错误拒绝
**And** 不得通过 `JSON.parse(...) as ProtocolMessage` 或其他断言绕过校验。

**Given** 一个成功 Response
**When** Codec 完成 envelope 解码但尚未关联 Pending Request
**Then** Response body 保持 `unknown`
**And** 只有匹配原始 method 后才能通过该 method 的 result schema 交付。

**Given** Session/Transport portability fixture
**When** 在不引入 React、DOM、Node HTTP、剪贴板、下游执行器或 Socket.IO runtime 的环境中类型检查
**Then** 公共 contracts 与 message-only fake 必须通过
**And** protocol package 不得产生这些环境依赖。

**Given** 当前协议格式和同 major 最低支持 fixtures
**When** 执行 Codec、exports 与兼容性测试
**Then** 当前格式能够往返，支持范围内格式保持兼容，未知版本确定性失败
**And** breaking schema 变化必须同步提升 package major 与 `protocolVersion`。

### Story 1.2: 在健康 Socket.IO 链路上双向交换完整消息

As a Socket.IO Transport 使用者,
I want Client 与 accepted Server 通过固定 wire 双向交换完整 `Uint8Array` 消息,
So that Session 只看到保持原始字节、顺序和边界的完整消息，而无需了解 frame.

**FRs:** FR-15、FR-16、FR-18、FR-24、FR-26

**Acceptance Criteria:**

**Given** Socket.IO Client 与 accepted Server Socket 已建立健康连接
**When** 任一端发送 Transport 数据
**Then** 双端只使用单一二进制 `protocol:frame` 事件
**And** 不使用业务 method 作为 event，也不解析业务 JSON 或把 Socket.IO event ACK 当作 Transport ACK。

**Given** 一条 DATA frame
**When** 对其编码或解析
**Then** 使用 28-byte 大端 header，依次包含 `magic=0x5243`、`frameVersion=1`、`kind=1`、`frameSeq`、`messageId`、`chunkIndex`、`chunkCount`、`totalMessageBytes`、`payloadBytes`，之后紧跟 payload
**And** `payloadBytes` 必须与实际剩余字节数一致。

**Given** 一条 ACK frame
**When** 对其编码或解析
**Then** 它固定为 8 bytes，包含 `magic=0x5243`、`frameVersion=1`、`kind=2` 和累计 `nextExpectedFrameSeq`
**And** ACK 绕过 DATA window、不占用 DATA 序号且不再被 ACK。

**Given** 空消息、单片消息或多片消息
**When** Transport 使用默认 16 KiB payload 拆分
**Then** `chunkCount=max(1,ceil(totalMessageBytes/chunkPayloadBytes))`
**And** 空消息编码为一个零 payload DATA，非末片必须为完整 chunk，末片必须精确等于剩余字节。

**Given** 一个新的健康连接方向
**When** 第一批消息被编码
**Then** `frameSeq`、`messageId` 和 `nextExpectedFrameSeq` 分别从 0 连续递增且不得回绕
**And** DATA 最大序号为 `0xfffffffe`，`0xffffffff` 只用于最终累计 ACK。

**Given** 合法的空、单片、多片和 256 KiB 最大消息
**When** Client 或 Server 顺序发送并由对端接收
**Then** 只有完整且总长度一致的消息才向上交付一次
**And** 原始字节、提交顺序和消息边界均保持不变，不发生合并或部分交付。

**Given** Client 与 Server 在同一健康连接上同时提交多条消息
**When** 两个方向的 DATA、ACK 和完整消息交错到达
**Then** 每个方向独立维护从 0 开始的序号、窗口、messageId 与累计 ACK，并分别保持本方向的提交顺序和消息边界
**And** 任一方向的发送或 ACK progress 不得阻塞、确认或修改另一方向的状态。

**Given** receive listener 已收到完整消息
**When** listener 返回且 Transport 继续处理后续 frame
**Then** 已交付的 `Uint8Array` 不得被修改或复用
**And** 后续消息不得改变此前保存的字节内容。

**Given** 错误 magic、version、kind、header 长度、payload 长度或非 canonical chunk metadata
**When** frame parser 接收该二进制数据
**Then** 必须确定性拒绝该 frame，且不得向上交付任何部分消息
**And** generation-fatal 清理与错误分类由后续可靠性 Story 基于此解析结果执行。

**Given** 当前 wire 与同 major 最低支持的 golden fixtures
**When** 执行精确字节和 Client/Server healthy-path 互操作测试
**Then** DATA/ACK 编码逐字节匹配 fixture，双向消息互操作通过
**And** 负向 import fixture 证明 `./client` 不加载或导入 Server runtime、`./server` 不加载或导入 Client runtime，共享 wire/core 不从任何公共入口导出。

### Story 1.3: 显式管理主动端与 accepted 端的生命周期及 generation

As a Client 或 Server 组合根开发者,
I want 通过角色化 Transport API 连接、观察和关闭底层链路,
So that 我能够可靠编排生命周期，而无需让 Session 感知连接状态.

**FRs:** FR-19、FR-20、FR-27、FR-28

**Acceptance Criteria:**

**Given** `ClientTransport` 与 `ServerTransport` 公共契约
**When** 检查其能力面
**Then** 两者都提供 `kind`、`state`、`getLifecycleSnapshot()`、`subscribeLifecycle()`、`disconnect()` 和完整消息 `send/receive`
**And** 只有 ClientTransport 提供无参数 `connect()`，连接目标已在构造时封装。

**Given** 一个 lifecycle subscriber
**When** 调用 `subscribeLifecycle()`
**Then** 必须同步首发 immutable 当前快照，后续事件只能在内部状态写入后发布
**And** listener 按事件开始时的注册顺序快照调用、异常相互隔离、取消订阅幂等。

**Given** 任一 `TransportLifecycleSnapshot`
**When** 按 state 检查其判别联合字段
**Then** idle/disconnected 为 `generation:null`；connecting 增加 `deadlineAt`；connected 携带正整数 generation；reconnecting 携带 `generation:null/previousGeneration/attempt/maxAttempts/deadlineAt/lastError`；error 携带 `generation:null/error`
**And** reconnect attempt 从 1 开始，`deadlineAt` 是仅供观察的 Unix epoch ms，内部连接/恢复预算必须使用不受系统时钟跳变影响的单调时钟。

**Given** Client Transport 处于 `idle`、`disconnected` 或 `error`
**When** 调用 `connect()`
**Then** 启动一个最多 10 秒的显式连接周期，并为成功连接创建从 1 开始、单调且不复用的 generation
**And** 每个 generation 使用新的 Socket/Manager，传输序号和重组状态从初始值重新建立。

**Given** Client Transport 已 `connected` 或正在 `connecting`
**When** 一个或多个调用方再次调用 `connect()`
**Then** connected 时幂等成功，connecting 时加入同一个 single-flight Promise
**And** 任一调用方都不得启动第二个并行连接过程。

**Given** Transport 不处于 `connected`，或显式 stop intent 已经线性化
**When** 调用 `send()`
**Then** 立即以 call-local `not-delivered` 的结构化 `not-connected` 错误拒绝且不入队
**And** lifecycle snapshot 不能替代该 send Promise 的完成结果。

**Given** connect、disconnect 或 lifecycle listener 重入同时发生
**When** 调用 `disconnect()`
**Then** 先同步线性化 explicit-stop intent，再通过同一 FIFO transition queue 处理后续重入操作
**And** 取消 connect waiter、Socket listener 和 timer，在 Promise resolve 前写入并发布 `disconnected`，重复 disconnect 幂等。

**Given** 一个 MessageTransport receive stream 已有 active receiver
**When** 第二次注册 receiver
**Then** 必须同步、确定性失败且不能影响原 receiver
**And** 原 receiver 的 unsubscribe 幂等，取消后允许注册新的唯一 receiver，历史消息不回放。

**Given** Server Transport 包装一个 accepted Socket
**When** 构造完成
**Then** 它立即处于 `connected`、`generation=1`，可以收发完整消息且没有主动 `connect()`
**And** disconnect 后不尝试找回该 Socket，新 accepted Socket 必须创建新的 ServerTransport。

**Given** 旧 Socket 或旧生命周期周期仍有迟到的 connect、disconnect、error 或 frame callback
**When** 当前 lifecycle epoch 或 generation 已改变
**Then** 旧 callback 不得修改当前 snapshot、完成当前 send 或触发当前 listener
**And** 旧 generation 的 listener、timer 和内部状态必须可被释放。

**Given** Transport 生命周期操作失败
**When** 对外构造 `TransportLifecycleError`
**Then** 固定 `kind="transport-lifecycle"`，code 只能为 `connect-timeout | connect-failed | connection-lost | invalid-frame | reassembly-timeout | retransmission-exhausted | sequence-exhausted | connect-cancelled | internal`
**And** 原始 cause 可保留但控制流只使用稳定 `kind/code` guard，不依赖错误文本或跨包 `instanceof`。

### Story 1.4: 以有界并发和 Go-Back-N 获得确定交付结果

As a MessageTransport 使用者,
I want 并发提交完整消息并获得有界、可靠且不可反转的交付结果,
So that 我无需在 Session 中复制队列或重试状态机，也不会留下永久 pending 的发送.

**FRs:** FR-17、FR-18、FR-21、FR-22、FR-23、FR-25

**Acceptance Criteria:**

**Given** Transport 处于 connected 且消息未超过上限
**When** 调用 `send(message)`
**Then** Transport 在 admission 时同步取得该 `Uint8Array` 的稳定快照并返回独立 Promise
**And** 调用方随后修改原数组不得改变已入队或线上发送的字节。

**Given** 默认资源配置
**When** 接纳或拒绝新消息
**Then** 单消息上限为 256 KiB，队列上限为 128 条且 queued 与 awaiting-ACK 合计不超过 4 MiB
**And** 消息过大或新调用导致容量超限时，只以 call-local `not-delivered` 拒绝该调用，不影响已有发送。

**Given** 多个并发 send 已进入统一队列
**When** Transport 调度 DATA
**Then** 使用默认 16 KiB chunk 和最多 8 个未确认 DATA 的窗口，窗口可以跨越消息边界
**And** 必须保持提交顺序和消息边界，不提供公共 `sendBatch`。

**Given** 对端发送累计 ACK
**When** `nextExpectedFrameSeq` 严格推进
**Then** send base 前移，已完整确认的消息各自 resolve
**And** Transport ACK 只表示完整字节消息交付，不表示协议 Response 或 Operation completion。

**Given** 重复或回退 ACK
**When** 发送端处理该 ACK
**Then** 不推进 send base，也不重置 progress/retry deadline
**And** 只有累计 ACK 严格推进才算发送 progress 并重新计算当前窗口 deadline。

**Given** 当前窗口连续 2 秒没有严格 ACK progress
**When** ACK timeout 到达
**Then** 按 Go-Back-N 重发当前全部未确认 DATA
**And** 初次发送后最多重传 3 轮，预算耗尽时终结当前 generation。

**Given** 一个 send 已被 admission 接受
**When** 它在有界队列中等待、缓慢推进、停止收到 ACK、连接终止或被显式关闭
**Then** 必须基于队列、窗口、ACK timeout 与 retry 预算推导的有限上界恰好 settle 一次
**And** 使用可控时钟验证该性质，不新增公共 queue deadline 配置。

**Given** 单消息或队列容量拒绝
**When** 失败发生
**Then** 仅当前调用以 `scope="call"`、`delivery="not-delivered"` 失败
**And** 重传预算耗尽以 `scope="connection-generation"` 终结 generation，不把容量拒绝升级为连接失败。

**Given** generation-fatal 清理开始
**When** 存在 queued、in-flight 和发送 timer 状态
**Then** 必须原子清空发送队列、窗口与全部相关 timer
**And** 已可能发送 DATA 的调用返回 `delivery-unknown`，可证明未发送 DATA 的调用返回 `not-delivered`。

**Given** 任一 send 已 reject
**When** 旧 timer、ACK、Socket callback 或后续连接活动发生
**Then** 该消息新增本地 DATA frame 数必须保持为零，Promise 不得被复活或再次完成
**And** 错误通过稳定 `kind/code/scope/delivery/cause` 判别，不依赖 message 或跨包 `instanceof`。

**Given** Transport `send()` 被拒绝
**When** 对外构造 `TransportSendError`
**Then** 固定 `kind="transport-send"`、`scope="call" | "connection-generation"`、`delivery="not-delivered" | "delivery-unknown"`，code 只能为 `not-connected | message-too-large | queue-full | connection-ended | invalid-frame | reassembly-timeout | retransmission-exhausted | sequence-exhausted | internal`
**And** 每个 code 的 scope/delivery 必须与是否可能已有 DATA 离开本地一致，包装层保留 cause 且只通过结构化 guard 映射。

### Story 1.5: 严格重组入站 DATA 并统一清理非法 Generation

As a MessageTransport 接收者,
I want 只重组严格连续且 canonical 的 DATA，并在非法输入时统一终结 generation,
So that 重复、越序、损坏或超限 frame 不会造成部分交付、重复交付或资源泄漏.

**FRs:** FR-16、FR-22、FR-23、FR-25、FR-26、FR-27

**Acceptance Criteria:**

**Given** 接收端收到 DATA
**When** `frameSeq` 恰好等于 `nextExpectedFrameSeq` 且 message/chunk metadata canonical
**Then** 接纳 payload、推进期望 frame/chunk 并立即回复新的累计 ACK
**And** 只有期望序号严格推进才算 reassembly progress 并重置 10 秒无进展 deadline。

**Given** 接收端收到重复或越序 DATA
**When** frameSeq 不等于当前 nextExpectedFrameSeq
**Then** 不接纳 payload、不修改 message/chunk 重组状态，只回复当前累计 ACK
**And** 该输入不算 progress、不延长重组 deadline，也不造成重复完整消息交付。

**Given** 空消息、单片、多片或 256 KiB 最大消息的全部 canonical chunk 已连续接收
**When** chunkCount、totalMessageBytes 与累计 payload 长度精确一致
**Then** 只向唯一 receiver 交付一次稳定完整 `Uint8Array`，然后释放该消息重组缓存
**And** 连续消息保持提交顺序和边界，不发生部分交付、合并或 callback 后字节复用。

**Given** DATA metadata 非 canonical、字段长度矛盾、frame/message 超限或 messageId/chunkIndex 不连续
**When** parser/controller 处理该 frame
**Then** 不向上交付任何部分消息，并以结构化非法 frame 错误终结当前 generation
**And** 不尝试把不同 chunk 配置、wire version 或损坏 metadata 静默解释为另一种格式。

**Given** 双端使用不兼容的 `frameVersion`、`chunkPayloadBytes` 或 canonical framing 配置
**When** 接收端首次观察到无法按本地契约解释的 frame
**Then** 确定性终结当前 generation，且不交付任何部分或错误重组的完整消息
**And** 当前版本不进行在线协商、降级或双格式探测；兼容配置下的双向互操作与不兼容配置下的失败均有测试证据。

**Given** 发送端收到确认尚未发送 frame 的 future ACK，或 `frameSeq`、`messageId`、累计 ACK 序号即将耗尽
**When** 无法继续维持连续且不回绕的序号契约
**Then** 以 code=`sequence-exhausted` 的 connection-generation-fatal 错误终结 generation
**And** `messageId` 不得回绕，DATA `0xffffffff` 不得被发送，最终累计 ACK 之外不得使用保留值。

**Given** 一个未完成的 reassembly 连续 10 秒没有严格 progress
**When** no-progress deadline 到达
**Then** 以 generation-fatal 重组超时终结连接且不交付缓存中的部分字节
**And** 重复/越序 DATA 不得通过反复到达无限延长该 deadline。

**Given** 任一非法 frame、重组超时或序号耗尽触发 generation-fatal
**When** 当前 generation 同时存在发送队列、窗口、重组缓存、Socket listener 和 timer
**Then** 原子清空全部双向 generation 资源，并逐 send 按 DATA 是否可能离开本地分类 `not-delivered | delivery-unknown`
**And** 失败后的旧 DATA、ACK、timer 或 Socket callback 不得交付消息、发送新 frame 或复活 Promise。

**Given** golden-wire 与故障注入测试
**When** 覆盖 exact-next、重复、越序、future ACK、非 canonical metadata、长度矛盾、超限、无进展和序号耗尽
**Then** 每条输入得到验收契约规定的 ACK、交付或 fatal 结果
**And** 测试结束后发送/接收状态、listener、缓存和 timer 全部可证明已释放。

### Story 1.6: 在断线后有界恢复并隔离旧 Connection Generation

As a Socket.IO Client Transport 使用者,
I want Transport 在意外断线后自动建立全新的有限恢复周期,
So that 后续消息可以重新获得服务，同时任何旧代消息和回调都不会被重放或污染新连接.

**FRs:** FR-19、FR-21、FR-22、FR-23、FR-27、FR-28

**Acceptance Criteria:**

**Given** Client Transport 已至少成功建立过一个 Connection Generation
**When** 当前 Socket 意外断开或发生 connection-generation-fatal 错误
**Then** Transport 直接进入 `reconnecting`，不先发布终态 `disconnected` 或 `error`
**And** `connecting/reconnecting` 期间的新 `send()` 立即以 call-local `not-delivered` 失败且不入队。

**Given** 自动恢复开始
**When** 执行默认恢复策略
**Then** 最多进行 3 次尝试、总预算为 30 秒，尝试前延迟固定为 `[0, 1000, 3000]` ms，单次连接最多 10 秒并受剩余总预算截断
**And** 同一时刻只能存在一个连接或恢复尝试，重复 `connect()` 加入当前 single-flight readiness。

**Given** 一次新的恢复尝试
**When** 创建底层 Socket.IO 连接
**Then** 必须创建全新的 Socket 与 Manager，并禁用 Socket.IO 内建 reconnection、event retries、offline send buffer 和 connection-state recovery
**And** 新 generation 的 frame、message、ACK、window 和 reassembly 状态从初始值开始，connected generation 单调递增且不复用。

**Given** 旧 generation 仍有 queued、in-flight 或 awaiting-ACK 消息
**When** 该 generation 终结并开始恢复
**Then** 所有旧 `send()` 在恢复前恰好失败一次，按 DATA 是否可能离开本地分类为 `not-delivered` 或 `delivery-unknown`
**And** 新 generation 不继承、不重放也不复活任何旧消息、序号、ACK、窗口或重组状态。

**Given** 自动恢复成功
**When** 新 generation 进入 connected
**Then** 先写入包含新 generation 的 immutable lifecycle snapshot，再向订阅者发布 connected 事件
**And** 已注册的唯一完整消息 receiver 保持有效，Session 无需读取 lifecycle 或重新注册数据面。

**Given** 恢复预算耗尽
**When** 最后一次连接尝试失败或总 deadline 到达
**Then** Transport 清理全部尝试、listener、timer 和 generation 资源并进入结构化 `error`
**And** 后续不再自动恢复，直到调用者显式 `connect()` 开启新的连接周期。

**Given** Transport 正在 connecting 或 reconnecting
**When** 调用者显式 `disconnect()`
**Then** explicit-stop intent 立即线性化并取消当前及未来恢复尝试，在 Promise 完成前发布 `disconnected`
**And** 后续迟到的 connect、disconnect、DATA、ACK、timer 或 error callback 均不得改变当前状态或完成任何调用。

**Given** 可控 Socket 与时钟测试替身
**When** 覆盖初连失败、恢复成功、恢复耗尽、恢复中显式关闭和旧 callback 迟到
**Then** 每条状态序列、generation、尝试次数和 deadline 都与策略精确一致
**And** 所有终态路径均无 Socket listener、Manager、timer、发送队列或重组缓存泄漏。

### Story 1.7: 并发发送类型化请求并正确关联每个 Response

As a Browser 或 Server 协议集成者,
I want 通过业务无关的 `ProtocolSession` 并发调用类型化方法,
So that 每个 Request 都能独立获得经过校验的结果或结构化失败，而无需管理字节编解码和关联表.

**FRs:** FR-7、FR-8、FR-9、FR-10、FR-11、FR-14

**Acceptance Criteria:**

**Given** 新的 `@remote-copy/session` package
**When** 消费者检查其 root exports 和依赖
**Then** 它导出 `ProtocolSession`、Session errors/guards，并从 protocol 重导出 handler 所需协议类型
**And** 它只依赖 `@remote-copy/protocol`，不包含 Transport 生命周期、Socket.IO、SDK、React、DOM、Node HTTP 或输入执行依赖。

**Given** `ProtocolSession` 的冻结公共构造面
**When** 调用 `new ProtocolSession(transport, options)`
**Then** 第一个参数只接受 `MessageTransport`，Options 只包含 `codec`、`createRequestId`、`createHeartbeatId`、`responseTimeoutMs`、`maxPendingRequests`、`maxConcurrentHandlers`、`heartbeatIntervalMs`、`pongTimeoutMs`
**And** `codec`、Request ID 与 Heartbeat ID factory 均可注入以支持确定性测试；两类 ID 独立、非空、不混用，未知 option 不形成公共契约。

**Given** 一个只有 `send(message)` 与 `receive(listener)` 的 MessageTransport fake
**When** 构造 `ProtocolSession`
**Then** Session 同步占用唯一 receiver，并只通过 `MessageCodec` 交换完整 `Uint8Array`
**And** Session 不读取 state、generation 或 lifecycle，也不调用 `connect()` 或 `disconnect()`。

**Given** 调用 `request(method, body)`
**When** Session 创建并发送 Request
**Then** 必须在调用 Transport `send()` 前登记包含 method 的 Pending Request，并签发同一 Session 生命周期内不复用的 `requestId`
**And** 默认最多允许 128 个 Pending，容量外的新 Request 只以结构化 `pending-capacity` 失败且不影响已有调用。

**Given** Request A 与 B 的 Transport send 均未完成
**When** 调用方连续发起两个 request
**Then** Session 立即分别登记并调用两次 Transport `send()`，不创建第二套发送队列或串行门槛
**And** Response 可以逆序或早于对应 send Promise 完成到达，只完成相同 `requestId` 的调用。

**Given** 一个匹配 Pending Request 的成功或失败 Response
**When** Session 处理该 Response
**Then** 成功 body 必须按原始 method 的 result schema 校验后才交付，远端失败保留 ProtocolError code、message 和 retryable
**And** result 校验失败以结构化 `invalid-response` 终结该 Request，不得把未知 body 类型断言为可信结果。

**Given** Transport `send()` 成功且 Pending 仍未完成
**When** Delivery Promise resolve
**Then** 仅此时启动该 Request 独立的 Response timer，默认 10 秒且构造配置只接受 `1000..120000` ms 的有限整数
**And** 排队、连接与 Transport 重传时间不计入 Response timeout，超时只终结该 Request。

**Given** Response、send rejection、Response timeout 或 dispose 可能竞态到达
**When** 任一信号首先终结 Pending entry
**Then** 采用 first-terminal-wins 并保证调用最多完成一次，其他迟到 callback 均为 no-op
**And** send rejection 只完成仍 pending 的关联 Request、保留原始 `TransportSendError` cause，绝不隐式重试或批量失败其他 Pending。

**Given** 未知、重复或迟到的 Response
**When** Session 无法找到仍 pending 的匹配项
**Then** 只向 `subscribeError` 发布结构化 diagnostic，不匹配其他 Request 也不反转已完成调用
**And** 并发、早到、逆序、超时和 first-wins 行为均由 message-only fake 与可控时钟测试覆盖。

### Story 1.8: 处理类型化入站请求与 Notification

As a Client 或 Server 协议对端开发者,
I want 在同一个 `ProtocolSession` 中处理类型化入站调用与 Notification,
So that 双端可以复用一致的协议行为，而无需手工构造或分发协议 envelope.

**FRs:** FR-12、FR-13、FR-14

**Acceptance Criteria:**

**Given** 通过 `handleRequest(method, handler)` 注册的类型化 handler
**When** 收到经过 Codec 校验的 Request
**Then** 只调用匹配 method 的 handler，并使用相同 `requestId` 返回经过 result schema 校验的成功 Response
**And** 未注册 method 返回 `method.unsupported`，已知 `ProtocolRequestError` 保留其协议错误，其余异常只返回非重试 `request.failed`。

**Given** 默认最多 128 个并发入站 handler
**When** 新 Request 超过容量
**Then** 不执行 handler 并返回可重试 `request.capacity-exhausted`
**And** 其他正在执行的 handler、普通 Pending Request 和 Transport 连接不受影响。

**Given** 一个正在执行或仍在完成 tombstone 窗口内的入站 `requestId`
**When** 收到重复 Request
**Then** 不再次执行 handler，并返回 `request.duplicate`
**And** tombstone 默认最多 1024 条、最长 10 分钟，先达到者生效；只淘汰最早的已完成 tombstone，绝不淘汰 active handler 记录。

**Given** Notification subscriber 已注册
**When** 调用 `notify()` 或收到合法 Notification
**Then** 出站 Notification 只等待 Transport Delivery，入站 Notification 按事件开始时的注册顺序快照分发且不回放历史
**And** subscribe/unsubscribe 只影响下一事件、取消幂等、listener 异常隔离，非法 Notification 不进入 subscriber。

**Given** Codec 解码失败、handler callback 迟到或 handler 已失效
**When** 非法字节或异步结果到达
**Then** 非法输入只发布 validation diagnostic 且不调用 handler，失效 callback 不得发送 Response 或 Notification
**And** Session diagnostics 使用稳定 `kind/code/cause` guard，不依赖错误文本或跨包 `instanceof`。

**Given** 调用方通过 `subscribeError()` 观察 Session diagnostic
**When** 非法消息、未知 Response、未知 Pong、handler 失败、heartbeat send 失败或 heartbeat timeout 发生
**Then** 错误固定 `kind="session-diagnostic"`，code 只能为 `invalid-message | unknown-response | unknown-pong | handler-failed | heartbeat-send-failed | heartbeat-timeout`
**And** diagnostic 可保留 cause、按事件订阅者快照分发且不回放，不得被误作 Request rejection 或 Transport lifecycle 结果。

### Story 1.9: 运行隔离的 Heartbeat 并幂等释放 Session

As a Client 或 Server 协议组合根开发者,
I want 显式启动、停止 Heartbeat 并最终释放 Session,
So that 链路存活诊断不会混入普通 Request，结束后的异步回调也不会泄漏或复活状态.

**FRs:** FR-12、FR-14

**Acceptance Criteria:**

**Given** 构造 `ProtocolSession` 时配置 heartbeat
**When** 提供 `heartbeatIntervalMs` 或 `pongTimeoutMs`
**Then** 两个值都必须是以毫秒为单位的有限正整数，默认分别为 15000 与 10000
**And** 零、负数、非整数、NaN 或 Infinity 在构造时确定性失败，不创建 receiver、Pending 或 timer。

**Given** Session 收到合法 Ping
**When** 处理该 heartbeatId
**Then** 通过 Transport 回复相同 heartbeatId 的 Pong，而不创建 Request Pending 或混用 requestId
**And** 未知或迟到 Pong 只产生 diagnostic，不完成普通 Request 或当前 heartbeat。

**Given** 调用 `startHeartbeat()`
**When** heartbeat interval 发出 Ping 且其 Transport Delivery 成功
**Then** 只在 Delivery 后启动 Pong timer，同一 Session 最多等待一个当前 run 的 Pong
**And** 匹配 Pong 清除 timer；timeout 只停止当前 heartbeat run 并发布 `heartbeat-timeout`，不读取 Transport state、不关闭 Transport也不批量失败普通 Pending。

**Given** `stopHeartbeat()` 后仍有旧 send callback、timer 或 Pong 到达
**When** heartbeat run epoch 已改变
**Then** 所有旧 callback 均失效且不得重启 timer、发布 timeout 或修改新 run
**And** 重复 start/stop、Delivery failure 和 Pong 竞态由可控时钟验证且无 timer 泄漏。

**Given** Heartbeat Ping 的 Transport `send()` 失败
**When** 结构化 cause 为 call-scope capacity failure 或 connection-generation-scope failure
**Then** 两种情况都不启动 Pong timer，并发布保留 cause 的 `heartbeat-send-failed` diagnostic；call-scope 只等待下一个 interval 再试
**And** generation-scope 终止当前 heartbeat run，并等待 Transport lifecycle 驱动恢复，Session 不直接 disconnect、connect 或批量失败普通 Pending。

**Given** 调用 `dispose()` 一次或多次
**When** Session 进入本地终态
**Then** 同步且幂等地取消 receiver、订阅 callback、heartbeat/handler timer，并以 `session-disposed` 拒绝剩余 Pending
**And** dispose 不调用 Transport lifecycle API、不能撤回已交付字节；随后任何消息、timer、send 结果或 handler 结果均不得产生可观察写入。

## Epic 2: 产品集成者可迁移并使用可插拔远程操作链路

SDK、Server 与 Browser 集成者能够按安全顺序迁移到目标四包链路，最终通过注入式 `RemoteInputClient` 完成 ready、输入、Operation 追踪和恢复，并独立安装和验证各包。

### Story 2.1: 在 SDK 内建立可注入 Client Core 与应用 ready

As a SDK 维护者,
I want 先在 package 内完成注入式目标 Client core 与 ready 语义,
So that 后续 Server 与 Browser 能迁移到同一稳定实现，而不会在过渡期破坏现有应用.

**FRs:** FR-1、FR-2、FR-3、FR-4、FR-5

**Acceptance Criteria:**

**Given** `@remote-copy/sdk` 的 package-private 目标 Client core 和运行时依赖图
**When** SDK 内部以冻结的最终构造形状传入 `ClientTransport` 与 options
**Then** core 接受调用方创建且尚未使用的 Transport 实例，不接受 URL、Transport factory 或具体 Socket.IO 配置
**And** core 不导入、不重导出也不默认选择 `@remote-copy/transport-socket-io`；本 Story 不从 package exports 暴露 V2 名称、临时 subpath、alias 或 constructor overload。

**Given** Browser 仍通过现有 SDK root facade 工作
**When** 本 Story 引入目标 core
**Then** Browser 和 SDK root 的旧公开签名保持不变；现有 facade 对本 Story 已迁移的 lifecycle/ready 能力只委托 core，尚未迁移的交互继续使用既有实现
**And** 每个后续 SDK Story 在迁入一项能力时同步删除 facade 中对应的旧逻辑，不修改 Browser composition、不新增同能力的第二套状态机或运行时双接口探测。

**Given** 一个刚构造的 Client
**When** 调用 `getState()` 或 `subscribeState(listener)`
**Then** 返回同一权威 immutable `RemoteInputState`，精确包含 `connectionState/transportKind/transportLifecycle/peer/capabilities/peers/currentOperation/isSubmitting/error`
**And** `subscribeState` 同步首发当前快照，后续按事件开始时的 listener 顺序快照分发、异常隔离且取消幂等。

**Given** `RemoteInputState.error` 非 null
**When** Client 发布可观察诊断
**Then** 错误固定 `kind="client-diagnostic"`，code 只能为 `connect-timeout | transport-failed | recovery-exhausted | session-open-failed | heartbeat-timeout | invalid-message | remote-error | operation-cache-full`
**And** 保留结构化 cause但不泄漏 Socket.IO 原始错误给公共控制流；intentional connect-cancelled 最终状态为 disconnected 且 error=null。

**Given** Client 处于 idle、disconnected 或可重新进入的 error
**When** 调用 `connect()`
**Then** 为本次显式 Client cycle 创建一个新的 `ProtocolSession`，先安装 Notification/error 订阅，再订阅 Transport lifecycle 并调用无参数 `transport.connect()`
**And** Session 在该 cycle 的全部 Transport generation 中保持同一个 receiver，Browser 调用者无需直接构造或访问 Session。

**Given** Transport 尚未 connected
**When** 建链正在进行
**Then** Client 状态为 `connecting`，初次 Transport connect 预算最多 10 秒，整个应用 readiness 总预算默认 30 秒
**And** 所有业务 API 在 ready 前以稳定 `not-ready` 失败且不向 Session 或 Transport 建立业务队列。

**Given** 当前 Transport generation 首次进入 connected
**When** Client 开始应用握手
**Then** 状态先进入 `opening`，并为该 generation 恰好调用一次类型化 `session.open`
**And** 只有经过校验的 open result 写入 peer/capabilities 且当前 cycle 与 generation 仍匹配时，状态才进入 `ready`、启动 heartbeat 并 resolve `connect()`。

**Given** `session.peers` 在 open Response 之前到达
**When** Notification 已经过当前 Session/Codec 校验
**Then** Client 可以按当前 cycle/generation 暂存并在 ready 快照中发布 peers
**And** 不丢失订阅安装后、open Response 前到达的合法 Notification。

**Given** Client 正在 connecting 或 opening，或者已经 ready
**When** 一个或多个调用方再次调用 `connect()`
**Then** connecting/opening 时加入同一个 readiness single-flight，ready 时幂等成功
**And** 不创建第二个 Session、第二次初连或同 generation 的第二次 `session.open`。

**Given** 初次 Transport 建链失败、readiness 总期限到达，或 `session.open` 返回 ProtocolError/非法 result
**When** 本次 connect 终结
**Then** 分别以 `ClientConnectError` 的 `transport-failed`、`connect-timeout` 或 `session-open-failed` 拒绝，并将同一 cause 投影到可观察 Client diagnostic
**And** 停止 heartbeat、清除 ready、dispose 本 cycle Session、显式关闭当前 Transport generation，之后同一 Client 仍可再次显式 connect。

**Given** package-private core 与现有 facade 共处迁移期
**When** 运行 SDK 内部目标 API 测试、现有 Browser 测试、全仓类型检查与构建
**Then** core 的注入、ready、状态与 bundle 边界通过，旧 Browser 继续从原 SDK root 编译运行
**And** Browser bundle 不包含 Server runtime 或未选择 Transport，目标 core 不形成可被外部长期依赖的临时公开入口。

### Story 2.2: 跨 Transport Generation 自动恢复 ready

As a RemoteInputClient 使用者,
I want Client 在 Transport 自动恢复时为新 generation 重新完成应用握手,
So that 旧 generation 的迟到结果不会污染当前会话，恢复后的业务调用仍只在 ready 后开始.

**FRs:** FR-4、FR-5、FR-6

**Acceptance Criteria:**

**Given** 目标 Client core 尚未执行 public cutover
**When** 本 Story 增强自动恢复
**Then** 只修改 package-private core 与其内部测试，现有 SDK facade 复用同一实现且 Browser composition 保持不变
**And** SDK、Browser、Server 的测试、类型检查和构建继续通过。

**Given** Client 已 ready 且 Transport 离开 connected
**When** lifecycle snapshot 进入 reconnecting
**Then** Client 立即清除 ready、停止当前 heartbeat并进入 `reconnecting`
**And** 不 dispose 当前 cycle 的 Session，已完成 Transport Delivery 的 Pending Request 继续等待各自 Response deadline。

**Given** 同一显式 Client cycle 内恢复得到新的 connected generation
**When** Client 观察到严格更大的 generation
**Then** 复用当前 Session 与已安装订阅，为新 generation 恰好执行一次 `session.open`，open 期间保持 not-ready
**And** 只有匹配 `clientCycleId + generation` 的成功结果才能重新进入 ready 并启动新的 heartbeat run。

**Given** 旧 generation 的 open Response、timeout、Session diagnostic 或 lifecycle callback 迟到
**When** 当前 cycle 或 generation 已改变
**Then** 迟到结果不得修改 state、peer、capabilities、peers、heartbeat 或 readiness Promise
**And** 所有异步写入都必须同时校验 clientCycleId 与 generation，而不能只比较 Transport state。

**Given** `session.open` 因结构化 `transport-send-failed` 失败
**When** cause 的 scope 为 `connection-generation`
**Then** Client 不再次显式 disconnect，也不把正在进行的自动恢复误判为普通 open failure，而由 lifecycle 决定下一代或 recovery-exhausted
**And** 只有 call-scope failure 且本 generation 仍 connected 时，才关闭该 generation 并报告 `session-open-failed`。

**Given** Transport 恢复预算耗尽
**When** lifecycle 进入 error
**Then** Client 进入 error 并以 `ClientConnectError(code="recovery-exhausted")` 完成仍等待的 readiness
**And** 清除 ready、停止 heartbeat但保留 Session，直到后续显式 disconnect/connect 周期执行确定性 dispose。

**Given** 已 ready Client 的新 generation 正在执行 `session.open`
**When** open 返回 ProtocolError、非法 result 或本次 readiness deadline 到达
**Then** 清除 ready、停止 heartbeat、保留当前 cycle Session，以显式 `transport.disconnect()` 关闭本 generation并抑制继续自动恢复，然后进入 Client `error`
**And** 失败映射为 `session-open-failed` 或 `connect-timeout`，不得无限创建 generation；只有 generation-scope transport-send failure 继续遵守 lifecycle 驱动的恢复分支。

### Story 2.3: 线性化显式关闭、重连与 Heartbeat 恢复

As a RemoteInputClient 使用者,
I want 显式连接周期与 heartbeat 触发的重连通过同一顺序状态机执行,
So that 重入和竞态不会创建多个 Session、污染状态或让已取消的连接重新 ready.

**FRs:** FR-2、FR-4、FR-5、FR-6

**Acceptance Criteria:**

**Given** 目标 Client core 尚未执行 public cutover
**When** 本 Story 增强显式连接周期
**Then** 只修改 package-private core 与其内部测试，现有 SDK facade 不复制 transition、Session 或 heartbeat 状态机
**And** Browser composition 保持不变，全仓测试、类型检查和构建继续通过。

**Given** 当前 cycle/generation 的 heartbeat 发布 `heartbeat-timeout`
**When** Client 处理该 diagnostic
**Then** 清除 ready并通过同一 Client transition queue 串行执行 `transport.disconnect()` 后 `transport.connect()`，强制产生新 generation
**And** 旧 heartbeat run 与旧连接 callback 不能影响新的连接周期。

**Given** Client 处于 connecting、opening、ready、reconnecting 或 error
**When** 调用 `disconnect()`
**Then** 先进入 `disconnecting`，停止 heartbeat、同步 dispose 当前 Session，再等待 Transport 显式 disconnect，最终状态为 `disconnected` 且 `error=null`
**And** disconnect single-flight 幂等、抑制自动恢复，并以 `connect-cancelled` 拒绝被取消的 connect waiter。

**Given** disconnect 尚未完成且调用者再次 connect，或 lifecycle listener 内重入 connect/disconnect
**When** transition 发生竞态
**Then** 所有显式操作通过 FIFO transition queue 线性化，disconnect 后的新 connect 使用同一 Transport 实例但创建全新 Session 和 clientCycleId
**And** 旧 cycle 的 open、heartbeat、Session diagnostic、Transport callback 和 connect waiter 都不能写入新 cycle。

**Given** 同一 Client 与同一可复用 Client Transport
**When** 连续完成 connect、disconnect、connect、disconnect，或在 transition listener 中重入操作
**Then** 每个显式 cycle 恰好创建并 dispose 一个 Session，每个 connected generation 恰好执行一次 `session.open`
**And** 可控时钟测试验证状态顺序、single-flight、FIFO、取消结果和 timer/listener 清理均确定且有界。

**Given** Client 在 recovery-exhausted 或新代 open 失败后处于 `error`，且旧 Session 被有意保留
**When** 调用方直接再次调用 `connect()`
**Then** 同一 FIFO transition 先同步 dispose 旧 Session并释放唯一 receiver，再递增 clientCycleId、创建新 Session并开始新的显式 Transport cycle
**And** 旧 Pending、heartbeat、Notification、diagnostic 或 callback 均不能进入新 cycle，任一时刻不得有两个 Session 竞争同一 receive stream。

### Story 2.4: 提交文本并保留可恢复的 operationId 与错误语义

As a Browser 应用开发者,
I want 通过 `inputText()` 提交文本并在所有结果中获得稳定 operationId 与错误分类,
So that 交付不确定或 Response 失败后我可以安全查询或复用同一业务标识.

**FRs:** FR-2、FR-31

**Acceptance Criteria:**

**Given** 目标 Client core 尚未执行 public cutover
**When** 本 Story 实现 `inputText()`
**Then** `inputText()` 只属于 package-private target core；现有 facade 的既有 `sendInput()` 可暂时委托同一 core 逻辑但不得形成第二套提交实现
**And** 不新增 public alias、V2 入口或双接口探测，Browser composition 保持不变且全仓绿色。

**Given** 调用 `inputText(text, options)` 且 operationId 尚未创建
**When** 文本为空、UTF-8 超过 64 KiB、Client 未 ready、能力不支持或已有输入正在提交
**Then** 分别以 `input-empty`、`input-too-large`、`not-ready`、`unsupported` 或 `busy` 的 `InputTextError` 失败
**And** 这些 ID 创建前失败的 `operationId` 必须为 null，且不得调用 Session request 或 Transport send。

**Given** 输入通过本地前置校验
**When** 调用方提供 operationId 或 Client 生成新 ID
**Then** 在发送前确定唯一 operationId，将 `isSubmitting` 写入并发布 Client state，再调用 `session.request("input.submit", { operationId, text })`
**And** Client 不直接构造协议 envelope、不调用 Transport `send()`，也不把 requestId 当作 operationId。

**Given** `input.submit` 返回成功 Response
**When** Client 完成 `inputText()`
**Then** 只返回 `{ operationId }` 表示当前协议下游已接受请求
**And** 不把 Transport ACK 或 Request Response 写成 Operation succeeded/failed，长期 terminal 状态只来自权威 status 或 operation.get。

**Given** ID 创建后的 SessionRequestError
**When** Client 映射为 InputTextError
**Then** transport send cause 按 delivery 映射为 `not-delivered` 或 `delivery-unknown`，其他 code 映射为 `response-timeout`、`remote-error`、`invalid-response`、`session-disposed`，pending-capacity 映射为 `not-delivered`
**And** 每个错误都保留相同非空 operationId 与完整 cause 链，不依赖 Socket.IO 文本或跨包 `instanceof`。

**Given** Transport 返回 `delivery-unknown`
**When** Client 向应用交付 InputTextError
**Then** 不得标记为可安全自动重试，也不得自动创建新 operationId 或重发 input.submit
**And** 调用方保留该 ID；Client 不在本 Story 内推断远端结果，也不代替调用方执行查询或显式重试决策。

**Given** inputText 的 Response、Notification、disconnect 或错误竞态结束
**When** 当前提交完成
**Then** `isSubmitting` 只由当前 clientCycleId 与本次提交 token 清除并发布一次
**And** 旧调用的迟到结果不得清除新提交的 busy 状态、覆盖当前 error 或修改新 cycle 的 Client state。

### Story 2.5: 查询并订阅严格递增的 Operation 与 Notification 视图

As a RemoteInputClient 使用者,
I want 从 SDK 查询和订阅权威 Operation 状态与经过校验的 Notification,
So that UI 可以稳定呈现长期进度而不解析协议或接受陈旧状态回退.

**FRs:** FR-2、FR-31

**Acceptance Criteria:**

**Given** 目标 Client core 尚未执行 public cutover
**When** 本 Story增加 OperationStore、查询与订阅
**Then** Store 只存在于 target core 并成为 SDK 内唯一权威 Operation 实现，现有 facade 不维护平行缓存
**And** Browser composition 保持不变，SDK、Browser、Server 的测试、类型检查和构建继续通过。

**Given** OperationStore 收到未知 operation 的首个合法 snapshot
**When** state 为任一公共 `accepted | processing | succeeded | failed`
**Then** 接受该快照并设为当前权威状态，保留其 stage、progress、error 与 revision
**And** `stage` 只表达下游阶段，`succeeded` 只表示当前协议下游完成自身职责。

**Given** 已缓存 Operation 收到更高 revision 更新
**When** 校验状态迁移
**Then** 只允许 accepted 到 accepted/processing/succeeded/failed、processing 到 processing/succeeded/failed，以及同一非 terminal state 的更高 revision
**And** 相同或更低 revision、非法状态回退和 succeeded/failed 后任何迁移均被忽略且不通知订阅者。

**Given** 调用 `getOperationStatus(operationId)` 或 `subscribeOperation(operationId, listener)`
**When** 本地存在缓存
**Then** get 同步返回 immutable 当前快照，subscribe 同步首发该快照并只投递后续成功应用的更新
**And** 无缓存时 get 返回 null、subscribe 不虚构 optimistic 状态，取消订阅幂等且 listener 异常隔离。

**Given** Client 已 ready
**When** 调用 `refreshOperationStatus(operationId)`
**Then** 通过类型化 `session.request("operation.get", { operationId })` 获取权威 snapshot，应用同一 revision/transition 规则后返回当前结果
**And** 查询不绕过 Session、不直接访问 Transport，也不因旧 Response 覆盖更新的 Notification。

**Given** 收到经过 Session/Codec 校验的 `operation.status` 或 `session.peers` Notification
**When** Client 分发应用视图
**Then** operation.status 先进入 OperationStore，session.peers 只更新当前 cycle 的 peers，原始合法 Notification 同时交付 `subscribeNotification`
**And** Notification 不回放历史，fanout 按事件开始时的订阅者快照调用、异常隔离且取消幂等。

**Given** `operation.status` 在对应 `input.submit` Response 前到达
**When** Notification 匹配当前 cycle 且 revision 合法
**Then** 立即合并到 OperationStore 并通知订阅者
**And** 随后的 accepted Response 不得写入本地 optimistic snapshot，也不得以更低 revision 覆盖该权威状态。

**Given** OperationStore 已达到默认 1000 条上限
**When** 新未知 operation 到达
**Then** 优先淘汰最旧 terminal snapshot且不得淘汰 active/current operation；如无可淘汰项则拒绝新记录
**And** 通过 `subscribeState` 发布 `ClientDiagnosticError(code="operation-cache-full")`，既有缓存和订阅保持可用。

**Given** Transport 在同一显式 cycle 内自动重连，Client 显式 disconnect，或开始新的显式 connection cycle
**When** 管理缓存生命周期
**Then** 自动重连保留缓存，disconnect 后缓存保持只读可查询，下一显式 cycle 开始时清空旧缓存和 currentOperation
**And** 旧 cycle 的 Notification、refresh Response 或 subscriber callback 不得重新写入新 cycle 的 Store。

### Story 2.6: 为每个 accepted Socket 组合 Server Transport 与 Session

As a Server 集成者,
I want 为每个 accepted Socket 创建角色正确的 Transport 与通用 Session,
So that Server 可以完成 `session.open` 与 peer 生命周期，而不依赖 Browser SDK 或解析业务 JSON.

**FRs:** FR-3、FR-24、FR-28、FR-32

**Acceptance Criteria:**

**Given** Socket.IO Server 接受一个新 Socket
**When** 建立协议对端
**Then** 同步创建一个已 `connected/generation=1` 的 `SocketIoServerTransport` 和独占它的 `ProtocolSession`
**And** Server 只从 `@remote-copy/transport-socket-io/server` 与 `@remote-copy/session` 导入 runtime，不依赖 `@remote-copy/sdk` 或 Client Transport 子路径。

**Given** 现有 Node Server 同时托管 Browser 静态资源
**When** 迁移 accepted-Socket 组合根与依赖入口
**Then** 保持同一 HTTP/Socket.IO Server 的静态文件路径、fallback 与启动行为不变，并以 Server 测试验证生产 Client 资源仍可访问
**And** 本次只改变进程内协议组合，不新增服务、端口、数据库或部署拓扑。

**Given** 新 Session 尚未成功处理 `session.open`
**When** 收到 `input.submit` 或 `operation.get`
**Then** 通过类型化 handler 返回 `session.required`，不得执行输入副作用、查询或订阅绑定
**And** 同一 open gate 适用于目标组合中的全部业务 handler，不由 Transport 或原始 Socket event 旁路。

**Given** `session.open` 成功
**When** Server 处理当前三个 method 与 peer/operation Notification
**Then** 数据与错误都通过统一 definitions/Codec/Session 校验，Server 不直接关联 requestId、构造 envelope 或调用 `JSON.parse()` 解析协议
**And** 本 Story 先将既有输入与查询 service 绑定到目标类型化 handlers，peer 与 operation 更新只通过 `session.notify()` 发送，Transport 仍只理解完整字节消息。

**Given** 同一连接重复调用 `session.open`
**When** clientName 未变化或发生更新
**Then** open 幂等返回同一 peer identity，只在可观察 peer snapshot 确有变化时广播一次
**And** 不创建第二个 Transport、Session 或 peer 记录。

**Given** 多个连接加入、更新名称或断开
**When** Server 广播 `session.peers`
**Then** 每个已 open Session 收到经过 Session 编码的当前 peer snapshot，未 open/已结束 Session 不接收
**And** 广播 listener 的异常或单连接发送失败不阻断其他连接的状态推进。

**Given** accepted Transport disconnect、进入 fatal error 或被 Server 关闭
**When** 当前连接终结
**Then** 恰好 dispose 对应 Session、解绑该连接的 peer 与既有 service callback，并移除所有 Socket/Session listener
**And** ServerTransport 不主动找回旧 Socket；同一 Client 的新 Socket 必须创建新的 Transport/Session 并重新要求 `session.open`。

**Given** Server 组合根显式启动 heartbeat
**When** 收到当前 Session 的 `heartbeat-timeout`
**Then** 关闭当前 accepted ServerTransport，而不是尝试恢复该 Socket
**And** Session diagnostic、Transport lifecycle 和连接清理均最多处理一次且不泄漏 timer 或引用。

**Given** Server 集成测试使用真实 Socket.IO
**When** 验证连接与协议互操作
**Then** 自动真实联调只发送 `session.open` 并验证 peer/Session 生命周期
**And** 不发送非空 `input.submit`，输入成功路径留给无 OS 副作用的 message-only fake/direct handler 测试。

**Given** SDK root 与 Browser composition 尚未执行目标 cutover
**When** Server 切换到目标 `SocketIoServerTransport + ProtocolSession`
**Then** 现有 legacy Browser 仍通过冻结的协议 envelope 与 wire 成功完成 `session.open`，既有静态页面和连接流程继续工作
**And** 本 Story 不修改 Browser composition、不切换 SDK root，也不要求 legacy Browser 使用目标 Client API。

**Given** 现有生产 Server 仍承担输入请求
**When** 本 Story 建立并接通目标组合模块
**Then** 在同一个可构建变更中迁移现有 handlers 与生产调用路径，保持既有输入、查询和通知行为绿色
**And** 删除被替代的内部协议路径且不新增兼容 adapter；进程级幂等 Registry、断线继续与 subscriber rebind 属于后续独立增强，不是本 Story 正常工作的前置条件。

### Story 2.7: 跨连接幂等执行并重新绑定长期 Operation

As a Server 下游实现者,
I want 在进程范围内按 operationId 幂等管理输入工作与订阅者,
So that Response 丢失或连接切换后调用方可以查询和复用同一 ID，而不会重复执行副作用或漏掉状态.

**FRs:** FR-3、FR-31、FR-32

**Acceptance Criteria:**

**Given** 新 Session 尚未成功处理 `session.open`
**When** 收到 `input.submit` 或 `operation.get`
**Then** 通过类型化 handler 返回 `session.required`，不得执行输入副作用、查询或订阅绑定
**And** 本 Story 将 OperationRegistry、两个 handlers 与 Story 2.6 的目标组合接入生产根，切换后不保留第二套协议处理路径。

**Given** 首次收到已 open Session 的 `input.submit(operationId, text)`
**When** OperationRegistry 接纳请求
**Then** 在一个无 await 临界区内完成全局 operationId claim、text hash 记录、subscriber 绑定和 `accepted/revision=1` snapshot
**And** 只有临界区完成后才启动异步 job、发送 Notification 或返回 accepted Response。

**Given** 同一 Server 进程再次收到相同 operationId
**When** text 相同或不同
**Then** 相同 ID+text 复用既有 Operation/job 并返回当前结果，不重复执行输入；相同 ID+不同 text 返回确定的 operation conflict
**And** 幂等域不按 connectionId 分区，Server restart 才开始新的进程级域。

**Given** `input.submit` 或 `operation.get` 需要绑定新 Session subscriber
**When** 读取当前 snapshot
**Then** 在同一同步临界区内先绑定 subscriber 再读取 snapshot，避免读取和订阅之间漏掉更新
**And** 状态更新在临界区内原子递增 revision、替换 snapshot 并取得 subscriber 快照，再在临界区外发送 Notification。

**Given** accepted job 尚未 terminal 时原连接断开
**When** Server 清理连接
**Then** 只解绑死 Session subscriber，job 和 Operation snapshot 独立继续到 terminal且不持有 Session 引用
**And** 新连接使用同一 operationId 查询或重试时重新绑定并收到当前及后续更高 revision，不重复副作用。

**Given** Operation 状态推进
**When** job 从 accepted 进入 processing 和 terminal
**Then** 公共 state 只使用 `accepted | processing | succeeded | failed`，每次权威更新 revision 严格递增且 terminal 后不回退
**And** `stage` 只表示 Server 的下游阶段，Transport ACK 与 Request Response 不生成 terminal 状态。

**Given** status cache 达到 1000 条
**When** 需要保存新 snapshot
**Then** 优先淘汰最旧 terminal snapshot且不淘汰 active；状态已淘汰但 tombstone 仍在的 ID 返回 `operation.expired`
**And** 最多 100000 个 `operationId + textHash` tombstone 在进程内不可淘汰，达到上限后新 ID 返回 `operation.capacity-exhausted` 而不复用旧 ID。

**Given** 无 OS 副作用的 InputExecutor fake 和多个 message-only Session
**When** 测试重复 submit、ID 冲突、Response 丢失、断线继续、查询 rebind、cache eviction 和 subscriber 竞态
**Then** 每个 operationId 最多启动一次 job，revision 与通知无缺口且按序
**And** 测试不得写剪贴板、触发粘贴或记录 input text、协议 body 与 frame payload。

**Given** OperationRegistry 已接入目标 Server，但 Browser 尚未 cutover
**When** 现有 legacy Browser 使用当前 `input.submit`、`operation.get` 与 Notification shape
**Then** 请求、查询和状态通知继续互操作，Server 不要求新 SDK 专属 envelope 或额外握手
**And** Browser composition 与 SDK root 切换留在下一 Story；本 Story 结束时 SDK、Server、Client 测试、类型检查和构建全部通过。

### Story 2.8: 原子切换 SDK Root 与 Browser 目标组合

As a Browser 应用维护者,
I want 在 Server 已就绪后一次性启用目标 `RemoteInputClient` 与显式 Client Transport,
So that UI 只消费目标状态、提交和 Operation API，迁移完成后不留下旧 facade 或兼容分支.

**FRs:** FR-1、FR-2、FR-3、FR-31、FR-32

**Acceptance Criteria:**

**Given** Stories 2.1-2.5 的 target Client core 与 Stories 2.6-2.7 的目标 Server 已完成
**When** 执行 SDK/Browser public cutover
**Then** SDK root 只将 target core 作为 `RemoteInputClient` 导出，Browser 从 `@remote-copy/transport-socket-io/client` 创建封装 origin/options 的 `SocketIoClientTransport` 并注入 `new RemoteInputClient(transport, options)`
**And** Browser 不传 URL 给 Client、不创建 Session，也不导入 Server runtime、frame/controller 或 protocol implementations。

**Given** 用户发起连接、断开或文本提交
**When** Browser hook 与组件调用 SDK
**Then** 只使用无参数 `connect()`/`disconnect()`、`inputText()`、Operation 查询和订阅 API
**And** 在同一变更中删除 legacy Client facade、URL constructor/factory 类型、`connect(url)`、`sendInput()` 和旧 event-union subscription，不保留 public V2 入口、constructor overload、alias、adapter 或运行时双接口探测。

**Given** Browser 的连接地址配置发生变化或同一地址需要显式重连
**When** 组合根更新 Client 实例
**Then** 地址变化时先完成旧 Client disconnect，再创建新的 Transport/Client；同一地址的显式重连复用当前 Client 与 Transport
**And** 旧 Client 的 open、Notification、error、heartbeat 或 Operation callback 不得写入新实例。

**Given** Client 发布 connecting、opening、ready、reconnecting、disconnecting、disconnected 或 error
**When** React UI 更新交互状态
**Then** 连接按钮、输入可用性、错误和 peer/operation 展示只从 `RemoteInputState` 与 SDK subscriptions 派生
**And** Transport connected 不显示为 ready，UI 不解析协议报文、Socket.IO event 或 Transport ACK。

**Given** 输入提交成功、失败或长期状态更新
**When** UI 维护历史与当前操作视图
**Then** 使用 SDK 返回或错误携带的 operationId 和严格 revision snapshot 更新显示，保留现有输入历史与交互布局
**And** 不把本地 optimistic 状态写回 SDK 权威缓存，不把 succeeded 文案固定解释为某个 Agent 已执行。

**Given** Client 自动恢复或显式重连
**When** UI 收到连续状态快照
**Then** 自动恢复期间保留可读 Operation 历史，显式新 cycle 按 SDK 规则开始新的权威缓存
**And** 旧 cycle 的错误、open 或 Notification 不得闪回覆盖当前 UI。

**Given** SDK root、Browser bundle 与组件测试
**When** 检查 exports、imports 并模拟连接、提交及 Operation 更新流程
**Then** 负向 type fixture 与 `rg` 证明旧 facade/API、overload、alias、adapter、公开 V2 入口和双接口探测均不存在，bundle 不包含 Server runtime、Node HTTP、剪贴板执行器或未选择的 Transport
**And** SDK、Browser、Server 测试、`pnpm check` 与 `pnpm build` 全部通过；自动真实联调只执行 `session.open`，不发送非空远程输入。

### Story 2.9: 固定四包发布形状并证明可独立消费

As a monorepo 与包发布维护者,
I want 固定 Protocol、Session、Socket.IO Transport 和 SDK 的 manifests、依赖与版本形状,
So that 每个包都能在仓库外按声明的边界安装、类型检查和运行，而不依赖另一个应用或工作区偶然提升的依赖.

**FRs:** FR-3、FR-29、FR-30

**Acceptance Criteria:**

**Given** 目标 workspace 布局与前序 Story 已建立的实现
**When** 检查 packages 与 source ownership
**Then** `@remote-copy/protocol`、`@remote-copy/session`、`@remote-copy/transport-socket-io`、`@remote-copy/sdk` 分别拥有协议/Codec、Session、私有 wire+双端 Transport、Client/OperationStore
**And** SDK/Browser 旧 API 已由 Story 2.8 删除；仍待清理的兼容面只限 protocol implementations 中迁移前已有的 Session/具体 Transport runtime，不得形成新的跨包依赖或第二套实现。

**Given** 四个 package manifests
**When** 检查 dependencies、exports、files 与发布元数据
**Then** SDK -> protocol+session、Session -> protocol、Transport -> protocol 均使用普通 `dependencies` 和 `workspace:^`，不使用内部 peerDependencies
**And** Socket.IO client/server runtime 也是 Transport 的普通 dependency；打包后所有内部 `workspace:^` 必须重写为同 major caret，目标 Transport 只公开 `./client` 与 `./server`，protocol 目标入口隔离，SDK 内部 store 不单独导出。

**Given** monorepo 工具链
**When** 更新 root/package manifests、lockfile、workspace 和 TypeScript references
**Then** 固定 Node.js `>=24.15.0 <25` 与单一 Node pin，保持 pnpm 10.0.0、TypeScript 7.0.2、Turborepo 2.10.4、Socket.IO 4.8.3 的架构版本
**And** 普通 build/check/test 图能够按包独立执行且不依赖手工编辑的 `dist/`、`.turbo/` 或 `public/` 内容。

**Given** 每个 package 的发布候选内容
**When** 分别执行 `pnpm pack` 并在四个全新临时 consumer 中只安装该 tarball 及其声明解析出的依赖
**Then** package name、version、files、exports、types 与 runtime imports 均来自 tarball，Protocol、Session、Client Transport、Server Transport 与 SDK 的代表性消费 fixture 各自通过类型检查或运行 smoke test
**And** 测试不得依赖 monorepo 路径别名、未声明的 hoisted dependency、另一个应用源码或预先存在的 workspace `dist`。

**Given** 四个 tarball 与依赖闭包
**When** 比较 Browser、Server 和 message-only Session fixture 的安装结果
**Then** Browser 不包含 Server runtime或未选择的 Transport，Server 不依赖 SDK，Session fixture 不引入 React、DOM、Node HTTP、剪贴板或输入执行类型
**And** 负向 fixture 同时证明 Transport `./client` 与 `./server` 不能交叉 import 对方 runtime；每个包都能独立版本化和发布，失败明确定位到缺失声明、错误 export 或跨边界 import。

### Story 2.10: 原子切换最终 Exports 并删除旧接口

As a monorepo 维护者,
I want 在全部应用与测试都已迁移后一次性删除 brownfield 公开面,
So that 仓库只剩目标四包边界，不会长期维护 alias、adapter 或两套运行时行为.

**FRs:** FR-3、FR-29、FR-30、FR-32

**Acceptance Criteria:**

**Given** Browser、Server、SDK 与测试调用方都已使用目标 API
**When** 执行最终 breaking cutover
**Then** 从 protocol implementations 移除 Session 与具体 Transport runtime，最终 root/definitions 只导出类型、常量和 ports，implementations 只导出 validation、guards 与 `JsonMessageCodec`
**And** Session runtime 只由 `@remote-copy/session` 提供，Socket.IO runtime 只由 `@remote-copy/transport-socket-io/client|server` 提供。

**Given** 搜索旧公开面和兼容代码
**When** 本 Story 完成
**Then** 本 Story 删除范围只包含 protocol implementations 中残留的 Session/具体 Transport runtime、旧跨包入口与相关测试引用；SDK/Browser 已删除的 factory、`sendInput`、URL connect 和 event-union API 继续由负向 gate 证明不存在
**And** 最终仓库不含 deprecated alias、构造 overload、运行时双接口探测、隐式具体 Transport、旧 adapter、Channel 或可回退的第二实现。

**Given** root `test:protocol` 脚本
**When** 执行协议层聚合测试
**Then** 依次覆盖 protocol、session 和 transport-socket-io package tests，并纳入 golden wire、exports 隔离、Browser bundle 与 Server import 边界
**And** `test:sdk` 与 `test:server` 继续独立运行，失败能够定位到所属 workspace。

**Given** 最终 export maps 与依赖图
**When** 从 Browser、Server 和只含 message-only fake 的 fixture 编译、打包并执行负向 import 检查
**Then** Browser 不加载 Server runtime或未选择 Transport，Server 不依赖 SDK，Session/Transport contracts 不引入 React、DOM、Node HTTP、剪贴板或输入执行类型
**And** 被禁止的旧入口与跨角色子路径必须解析失败，所有公开类型保持严格 TypeScript 判别联合并通过稳定 guards 交互。

**Given** 同 major 兼容性规则
**When** protocol envelope/method schema 或 DATA/ACK wire 变化
**Then** current 与该 major 最低支持的 golden fixtures 必须双向兼容，未知版本确定性失败
**And** breaking schema/wire 同时提升相关 package major 与 `protocolVersion` 或 `frameVersion`，不得静默漂移。

**Given** 该 cutover 涉及多个 workspace
**When** 变更提交前执行目标包测试、SDK/Server 测试、类型检查和构建
**Then** 所有消费者与 export fixtures 在同一个提交中保持绿色，不能留下需要未来 Story 才能修复的编译错误
**And** 生成产物不手工编辑；任何遗留旧符号由确定性的 `rg`/fixture gate 阻止合并。

### Story 2.11: 用全仓验证与中文文档冻结迁移结果

As a remote-copy 维护者,
I want 用所有权匹配的测试、构建和文档记录验证原子迁移,
So that 后续开发者可以依赖同一套架构、失败语义和安全联调规则，而不会恢复已删除的旧边界.

**FRs:** FR-3、FR-29、FR-30、FR-31、FR-32

**Acceptance Criteria:**

**Given** Protocol/Codec、Session、Transport、SDK 和 Server 的目标实现
**When** 审计测试所有权与覆盖矩阵
**Then** 覆盖全部协议 kind 与非法输入、Session 关联/handler/heartbeat/dispose、Transport wire/GBN/recovery/finality、SDK ready/operation/errors 和 Server open gate/idempotency/rebind
**And** 时间、重试、容量、迟到 callback 与资源清理使用可控 clock/fake 明确验证，不以仅 happy-path 的集成测试替代。

**Given** 自动化真实 Socket.IO 联调
**When** 运行 Client/Server 互操作测试
**Then** 只发送 `session.open`，不得发送非空 `input.submit`
**And** 输入成功、冲突、断线继续和 Notification 路径使用无 OS 副作用的 fake/direct handler，不触发本机剪贴板或粘贴。

**Given** 中文公共文档与仓库规则
**When** 更新根 README、SDK README、`docs/architecture.md`、`docs/implementation-plan.md` 和 `AGENTS.md`
**Then** 文档描述四包目标 ownership、注入式 Browser API、Server 组合、三种完成语义、结构化错误、Operation revision 和验证命令
**And** `AGENTS.md` 不再声称 Session/Transport 位于 protocol implementations 或 SDK 从 protocol 获取具体 Transport，并继续明确禁止当前实现/模拟 Bluetooth。

**Given** 日志与诊断路径
**When** 检查库、组合根和测试输出
**Then** 库不直接 console 或默认记录 input text、协议 body、frame payload、cause/stack；组合根只记录 code、ID、generation、大小和时序
**And** 当前部署仍明确限制为受信任本机/LAN，公网暴露前必须另行评审 TLS、认证、Origin allowlist、rate limiting 与审计。

**Given** 原子迁移完成
**When** 运行 `pnpm test:protocol`、`pnpm test:sdk`、`pnpm test:server`、`pnpm check` 和 `pnpm build`
**Then** 五个命令全部退出 0，workspace exports、类型依赖和 Browser/Server 构建一致
**And** `rg` 检查不存在旧 API/旧 ownership，生成产物未被手工编辑，任何失败都必须在交付前修复。

**Given** 完整实现与当前 PRD、Architecture Spine、SPEC、验收契约
**When** 执行最终需求追踪复核
**Then** 每个 FR、NFR 和 adopted AD 都至少由一条可执行 Story 与测试证据覆盖，不存在 placeholder、TBD、前向 Story 依赖或未决架构分歧
**And** 四包可独立消费、应用链保持 `RemoteInputClient -> ProtocolSession -> MessageCodec -> MessageTransport`，公共 Operation state 仍只有 accepted/processing/succeeded/failed。
