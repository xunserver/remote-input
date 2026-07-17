# 最终 Coaching 决策对账

## Verdict

**NEEDS REVISION。** 四包分层、每显式周期一个 Session、精确 lifecycle snapshot、Client/Session 公共方法、恢复预算和结构化 Session 错误均已正确落入 Spine；但仍有 4 处已确认语义未成为可执行不变量，其中前两处会直接产生不同的连接/发送结果。

## Findings

### [HIGH] F-1：Transport 命令状态机只落了恢复参数，未落已确认的调用结果

**确认来源：** memlog 109、123、124；用户确认 `send` 仅在 `connected` 接受新工作，其他所有状态立即以 `not-delivered` 拒绝；`ClientTransport.connect()` 在 `connected` 幂等成功、在 `connecting/reconnecting` 加入同一 single-flight；`disconnect()` 同步记录停止意图、取消 connect/recovery/listener/timer 并在 Promise 完成前发布 `disconnected`；清理期间及 lifecycle listener 内重入的 connect/disconnect 进入同一 FIFO。

**Spine 现状：** AD-9（114-118）只明确 `connecting/reconnecting` 时拒绝新 send，并描述 Client 级 connect；Verification（523）只以测试关键词提到 FIFO/取消。没有规则约束 `idle/disconnected/error` 的 send、Transport 级 connect single-flight、disconnect 的 event-before-Promise 以及重入命令排队。

**影响：** 实现可以在 disconnected 时排队、在 error 时采用不同错误，或让重入 disconnect 改变尚未 settle 的 connect 结果，仍可声称符合正文。

**修复：** 在 AD-6/AD-9 增加一条完整的 Managed Transport 命令规则，逐态固定 `send/connect/disconnect` 结果、同步 stop intent、snapshot 发布顺序和统一 FIFO transition queue。

### [HIGH] F-2：`session.open` 失败没有终止当前 Transport generation

**确认来源：** memlog 91 将最终 PRD/addendum 设为绑定输入；addendum 的 connect 契约要求 `session.open` ProtocolError、校验失败或 readiness 总期限耗尽时关闭当前 generation、进入 Client `error` 并 reject。memlog 134 进一步确认：初次 open 失败立即 dispose Session；已 ready 后新 generation open 失败保留 Session/Pending，但停止 heartbeat 并进入 error。

**Spine 现状：** AD-9（118）只写初次失败 dispose、恢复后失败进入 error/停止 heartbeat，没有要求 Client 关闭失败的 Transport generation。结构图也没有失败分支。

**影响：** 初次失败可留下 `Transport=connected + Client=error + 无 receiver`；恢复代 open 失败可留下仍 connected 的坏 generation。随后显式 connect 可能幂等复用该 generation，而不是建立干净的新代。

**修复：** 明确两条路径都串行关闭当前 Transport generation。初次失败立即 dispose Session，随后关闭 generation；已 ready 周期的恢复代失败关闭 generation，但保留 Session 直到其 Pending 自然超时或后续显式 cycle 清理。关闭动作不得触发自动恢复。

### [MEDIUM] F-3：已确认的 Session 构造契约和心跳默认值缺失

**确认来源：** memlog 120-121；用户确认构造依赖包括 `MessageTransport`、可选 `MessageCodec`、`createRequestId`、`createHeartbeatId`，配置名固定为 `responseTimeoutMs`、`maxPendingRequests`、`heartbeatIntervalMs`、`pongTimeoutMs`，默认分别为 10s、128、15s、10s，Response timeout 范围为 1s..120s。

**Spine 现状：** AD-4（84）只记录 Response timeout 与 Pending 上限；Public Session Shape（328-350）没有构造签名；全文没有 `pongTimeoutMs`、`createHeartbeatId` 或 15s/10s 心跳默认值。

**影响：** 两个实现可采用旧的 `requestTimeoutMs/heartbeatTimeoutMs`、不同 heartbeat timeout 或由 SDK 生成 heartbeatId，仍符合当前 Spine。

**修复：** 在 Structural Seed 加入 `ProtocolSession` 构造/options 形状，并在 AD-3 固定这些名称、默认值和 ID 所有权。

### [MEDIUM] F-4：`InputTextError` 的已确认判别码未落入公开错误合同

**确认来源：** memlog 116；用户确认公开码为 `input-empty | input-too-large | not-ready | unsupported | busy | not-delivered | delivery-unknown | response-timeout | remote-error | invalid-response | session-disposed`，并固定 `operationId:string|null` 与 `cause`。

**Spine 现状：** AD-12（136）仅提到 `InputTextError`、operationId/cause 与 delivery-unknown；Error Contracts（271-322）完全没有 `InputTextError` 类型或上述 code union。相反 `TransportSendErrorCode`（291）也只是未定义别名。

**影响：** SDK 实现可以继续沿用旧码或合并 `unsupported/busy/not-ready`，破坏已确认的跨包稳定判别。

**修复：** 在 Error Contracts 明列 `InputTextErrorCode` 与 `InputTextError` 结构；同时把 `TransportSendErrorCode` 定义为实际公开联合，或明确它由 protocol definitions 中哪一项稳定导出。

## Superseded-Semantics Check

未发现 Spine 重新引入以下已明确废弃语义：Transport factory 注入、Session lifecycle API、message/state/error event-union receive、每次自动重连重建 Session/Transport、仅显式重连、Transport 断线驱动 Session 批量清 Pending。AD-2、AD-3、AD-6、AD-9 与 AD-12 已正确排除这些旧设计。
