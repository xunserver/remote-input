# PRD Reviewer Gate Recheck

日期：2026-07-16

状态：`draft`，两个 phase blocker 均已确认，可以进入最终润色。

## 已闭合

- `send` reject 改为本地最终性，并区分 `not-delivered` 与 `delivery-unknown`。
- Client 生命周期事件强制携带单调 connection generation；`session.open`、ready 与 heartbeat 按 generation 隔离。
- receive listener 跨 Transport 内部重连保持有效，消息字节具有稳定所有权。
- Client Managed Transport 与 accepted Server Transport 的主动/被动生命周期分离。
- `client.connect()` 只在当前 generation 的 `session.open` 成功并 ready 后完成；初始 connect 与总 deadline 已固定。
- heartbeat send/timer 的 run epoch、超时起点和强制换链动作已固定。
- `delivery-unknown` 的 `operationId` 查询与同 ID 重试路径已补齐。
- 重复 Request 的有界防重窗口、Socket.IO 序号连续递增及不回绕约束已补齐。
- 协议异常行为、错误矩阵、Socket.IO 离线缓冲隔离和跨消息 DATA window 已补齐。

## Phase Blockers

无。

已确认旧 Socket generation 的未完成 `send` 不跨新 Socket 重放；`connecting/reconnecting` 期间拒绝新 `send`，主动 Client Transport 在意外断线或 connection-fatal 后按 3 次/30 秒预算自动恢复，耗尽后等待显式 `connect()`。
