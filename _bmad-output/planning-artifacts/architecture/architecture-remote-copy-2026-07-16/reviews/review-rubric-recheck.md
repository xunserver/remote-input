# Reviewer Gate Recheck

## Verdict

**NEEDS REVISION。** 上轮四项中三项已闭合；远端断线终态仍有一处规则冲突，并新增一处 reconnect operation 重建矛盾。机械 lint 继续为 0 findings。

## Previous Findings

| Finding | Status | Evidence |
| --- | --- | --- |
| R-1 跨连接重复副作用 | CLOSED | AD-10/AD-18 改为 Server 进程内全局 operationId、text hash 冲突检查、不可重用 tombstone，并明确 restart 为新幂等域。 |
| R-2 远端断线终态 | **OPEN** | AD-9、状态机和矩阵已区分普通 close=`disconnected`、fatal=`error`；但 AD-12 line 127 仍把未限定的“断线”列为 connection-fatal。 |
| R-3 SDK 资源错误映射 | CLOSED | lines 494-505 已固定 message-too-large、queue-full、ProtocolResponseError、validation、connect、fatal 和新增错误的映射。 |
| R-4 receive/lifecycle 验证 | CLOSED | Verification lines 567-569 已覆盖 receive 迁移、listener 语义、event-before-Promise、connect 淘汰、fatal/close 双端终态及 Server retry/query。 |

## Remaining High Findings

### [HIGH] RC-1：AD-12 仍把普通断线升级为 fatal

AD-9 line 109、Transport 状态说明 line 390 和矩阵 line 489 明确普通本地或远端 close 只进入 `disconnected`；AD-12 line 127 却仍规定“断线为 connection-fatal”。Client/Server 实现仍可据此选择 `error` 或 `disconnected`。应把 AD-12 改为：普通 close 执行完整清理但终态为 `disconnected`；只有非法帧、重组/ACK/序号等链路可靠性失败进入 fatal `error`。

### [HIGH] RC-2：OperationStore 初始迁移阻断重连后的状态恢复

Operation 状态机 lines 338-354 只允许首个状态为 `accepted`；AD-18 line 163 又要求新连接对既有 operation 重新 query/subscribe 并接收“当前状态”，该状态可能已经是 `processing`、`succeeded` 或 `failed`。SDK 在新 connect 时按 AD-14 清空缓存，因此会把合法的 terminal/current 快照当作非法初始迁移，导致 reconnect query 契约无法实现。

应明确：无缓存时，来自已校验 `operation.get` 或 Server current-status replay 的首个权威快照可从任意四种公共 state 建立基线；只有已有缓存后的增量通知才受状态迁移图约束。

未发现其他新的 critical/high 矛盾。
