# Protocol / Transport / Server 输入对账

## Verdict

架构 spine 的分层方向、Socket.IO wire 常量、Request/Response 关联和主要清理原则与当前实现一致，但尚不能直接作为无歧义实现合同。以下问题会改变公开接口、状态机、错误分类或 Server 对端行为，需在进入实现前回写架构决策。本文是静态对账；未修改架构正文，也未运行测试。

## Findings

- `AD-5` 把成功 Response 的 `result` 运行时校验归给 Codec（spine 82、347-350），与协议 envelope 的信息模型冲突。成功 Response 只有 `requestId` 和 `body: unknown`，不携带 method；`JsonMessageCodec.decode()` 只能校验 Response envelope（`packages/protocol/src/implementations/validation.ts:46-60`），真正的 result 校验依赖 pending entry 中的 method，发生在 `ProtocolSession.handleResponse()`（`packages/protocol/src/implementations/protocol-session.ts:294-313`）。架构应明确“Codec 校验 envelope，Session 按 pending.method 校验成功 body”，并在错误矩阵区分“整条消息无法解码”和“匹配 Response 的 body 非法”。

- `receive()` 是一次破坏性公开 API 改名，而不是现状确认。当前 `MessageTransport` 使用 `subscribe(listener)`（`packages/protocol/src/definitions/message-transport.ts:19-40`），Client、Server、Session、内存测试 Transport 都依赖该名称；内部 `SocketIoFragmentController.receive()` 接收的是原始 DATA/ACK frame（`packages/protocol/src/implementations/socket-io-fragment-controller.ts:173-190`）。若采用 spine 203-214 的 `receive(listener)`，必须把定义、两端实现、Session、SDK/Server 测试替身和中文 README 的迁移列为原子变更，并确保内部 raw-frame 方法同时改名，避免两种 receive 语义并存。

- 连接并发约定与现有已测试语义正面冲突。spine 154 要求同一实例并发 `connect/disconnect` 共享 in-flight Promise；当前 Socket.IO Client 每次 `connect()` 替换前一次连接并拒绝旧 Promise，且测试明确锁定该行为（`packages/protocol/tests/socket-io.test.mjs:701-731`）。`ProtocolSession.connect()` 同样用 generation 替换旧调用并拒绝旧 pending（`packages/protocol/src/implementations/protocol-session.ts:99-125`）。架构必须二选一：共享同目标的 in-flight 调用，或保留 latest-call-wins；还需定义 connect 与 disconnect 交叉时哪个调用获胜，不能只写“共享各自 Promise”。

- Transport 状态机是有意重做但缺少迁移约束。spine 新增 `disconnecting` 并要求所有 Transport 走 `Idle -> Connecting -> Connected`；当前状态联合没有 `disconnecting`（`packages/protocol/src/definitions/message-transport.ts:1-2`），Server Transport 包装已连接 Socket，`connect()` 从 `idle` 直接进入 `connected`（`packages/protocol/src/implementations/socket-io-server-transport.ts:47-121`）。需要决定 Server adapter 是否真的发布瞬时 `connecting`，以及 `disconnect()` 在同步清理完成时是否仍必须可观测地发布 `disconnecting`，否则 Client/Server “统一状态机”无法写出稳定测试。

- spine 106 要求 fatal 后保持 `error`，这与当前 Server Transport 不一致且需要明确事件顺序。当前 Server 先设 `error`，随后 `socket.disconnect(true)` 触发 disconnect listener，再覆写为 `disconnected`（`packages/protocol/src/implementations/socket-io-server-transport.ts:99-103,155-163`）；Client 因旧 socket guard 通常停留在 `error`（`packages/protocol/src/implementations/socket-io-client-transport.ts:262-274`）。除了新增终态一致性测试，还应规定 fatal 的唯一事件顺序（例如 `state:error` 后 `error`，底层 close 不再发 state）以及显式 `disconnect()` 从 error 转为 disconnected 的规则。

- 序号耗尽没有进入错误模型。当前 frame sequence 或 message ID 耗尽时只拒绝新的 `send()` 并要求重连，Transport 仍显示 `connected`，且此后永久无法发送（`packages/protocol/src/implementations/socket-io-fragment-controller.ts:125-136`）。spine 的 `TransportErrorCode` 没有 `sequence-exhausted`，错误矩阵也未决定它是当前调用失败还是 connection-fatal，虽然 Verification Contract 要求测试序号耗尽（spine 457）。必须选择“立即 fatal 并断链”或“进入明确 degraded/error 状态等待显式重连”，避免 connected-but-unsendable。

- fatal 清理目前依赖 state event，而 spine 又引入 `TransportError.fatal`，两者的权威关系未定义。当前 Session 只在收到 `state=error|disconnected` 时清 pending；单独的 error event 只向上转发（`packages/protocol/src/implementations/protocol-session.ts:255-290`）。若自定义 Transport 只发送 `{type:"error", fatal:true}`，AD-12 声称的清理不会发生。架构需规定 fatal Transport 必须原子完成资源清理并发布哪个 state，Session 是只信 state、只信 `fatal`，还是对二者做幂等处理，以及事件先后次序。

- spine 412 声称远端断线会使 Session generation 失效，但当前实现只停止 heartbeat、拒绝 pending，不递增 generation、不退订 Transport（`packages/protocol/src/implementations/protocol-session.ts:255-265`）。架构需要明确远端 disconnect/fatal 是否等价于调用 Session 的内部 close：递增 generation、取消订阅并禁止旧异步 request handler 再发送。否则 AD-4、AD-9 与错误矩阵对旧回调隔离的保证不完整。

- “一个 Transport 只能由一个 Session 拥有”（spine 88）只有文字规则，没有可执行所有权协议或验证项。当前多个 Session 可以同时 `subscribe()` 同一 Transport，从而重复处理 Request、互相看到未知 Response/Pong。架构需决定由组合根静态保证并加入负向测试，还是由 Transport/Session 在 attach/connect 时 claim ownership 并对第二个 owner 明确失败；否则该 invariant 无法被实现或验证。

- Server 会在 `session.open` Response 之前向新客户端排入 `session.peers` Notification。handler 在返回结果前执行 `void this.broadcastPeers()`（`apps/server/src/socket-io/protocol-server.ts:66-88`），而有序 Transport 会保留这个入队顺序。类似地，`input.submit` 的 accepted `operation.status` 可在 submit Response 前入队（`apps/server/src/socket-io/protocol-server.ts:90-110`，`apps/server/src/input/inputQueue.ts:27-40,76-104`）。spine 的 Opening/Ready 状态机和请求时序图没有规定早到 Notification 是缓存、立即合并还是丢弃。架构必须要求 SDK 在发 request 前建立 operation 接收槽，并定义 Opening 阶段 peer notification 的处理，否则真实 Server 顺序会产生丢状态或 ready 前状态污染。

- operation 去重范围与断线生命周期未定义。当前 Server 以 `(socket.id, operationId)` 为 key，因此只在同一 Socket 连接内去重；重连后复用相同 operationId 会创建新操作（`apps/server/src/input/inputQueue.ts:43-45,108-110`）。已入队/执行的 job 在客户端断线后继续执行，仍持有旧 Session 的通知闭包，发送失败仅记录日志；`removeClient()` 不取消 job 或清 operation（`apps/server/src/socket-io/protocol-server.ts:142-147`）。spine 的“长期 operationId/业务重试”“disconnect cleanup”和 Server verification 必须明确去重域、断线后 job 是继续还是取消、状态保留多久、旧通知 sink 何时释放。

- 重复 `session.open` 的语义缺失。当前 Server 允许同一连接重复 open、改名并重复广播 peers（`apps/server/src/socket-io/protocol-server.ts:66-88`）；spine 只规定 open 后进入 ready 和其他方法的 open gate。需要明确第二次 open 是幂等返回、允许更新 clientName，还是返回结构化 `session.already-open`，并加入 Server integration 测试，否则 SDK 重试和超时恢复会有不确定副作用。

- “每层定义稳定 code”（spine 153）尚未投影到 Session 契约。Structural Seed 只定义了 `TransportErrorCode`，而 Session 事件仍没有 `SessionError`/`SessionErrorCode`，现有实现对 not-connected、pending limit、timeout、unknown response/pong、connection replaced 等均抛普通 `Error` 并依赖消息文本（`packages/protocol/src/implementations/protocol-session.ts:99-156,185-197,294-313,401-405`）。若 SDK 必须稳定映射并保留 cause，架构需列出 Session 本地错误判别联合及远端 `ProtocolResponseError` 的映射边界；仅靠“不得用消息字符串”无法实现。

- Server integration 的 `disconnect cleanup` 验证项过于宽泛，现有测试没有覆盖它。当前 Server 测试只验证 open gate、同连接去重、状态/peers 通知和跨客户端隔离（`apps/server/tests/protocol-server.test.mjs:11-94`）；没有验证 Server clients map 移除、peer 离线快照、pending notification send、InputQueue job、重复 open 或 fatal Transport 的终态。Verification Contract 应把这些预期拆成可断言行为，特别是与上面 operation 断线决策一致的清理边界。
