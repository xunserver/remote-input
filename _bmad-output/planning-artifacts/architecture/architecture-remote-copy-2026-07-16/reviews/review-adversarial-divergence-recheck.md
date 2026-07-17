# Reviewer Gate - Adversarial Divergence Recheck

## Verdict

**FAIL.** 最新版已关闭 outbound `requestId` generation 复用和 early Response/send rejection first-wins 的主要分叉，也固定了 receive 无 replay、fatal 基本顺序、配对 chunk 配置、空消息和重传轮数。但以下 critical/high 歧义仍允许两套逐字合规实现产生不同 Promise 结果、wire 接受集合、operation 状态或 Server 副作用。

## Findings

- 同步 `connected` listener 的重入结果未定义。Transport 已写 `connected` 并同步发布 state 后，listener 立即调用 `disconnect()`：实现 A 在事件返回后复查 state/generation，使原 `connect()` reject；实现 B 认为建链已经成功，使 `connect()` resolve，随后 `disconnect()` resolve。两者都满足“state event 先于 Promise settle”“connected 时 disconnect 进入 disconnected”，但调用者得到相反 connect 结果。必须规定 lifecycle listener 引发的同步终止是否取消尚未 settle 的原 lifecycle Promise。

- fatal state listener 可破坏已规定的 fatal 可观察顺序。实现 A 在完成 `state=error -> error event` 前延迟 listener 发起的 `disconnect()`；实现 B 允许 `state=error` listener 同步执行 `error -> disconnected`，随后才发布 fatal error event。两者都同步调用 listener、允许显式 disconnect 使 error 进入 disconnected，但 error listener 看到的 `transport.state` 不同。必须规定 lifecycle mutation 在一次事件广播期间排队，或明确 reentrant transition 的唯一序列。

- listener 抛错的二次 error 路由仍不完整。Convention 要求继续其他 listener，矩阵又要求 Session 收到 error；实现 A 在向其他 listener 报告 `internal` 时排除抛错 listener，实现 B 仍调用原 listener但禁止 error-on-error 递归。两者都不中断 ACK/生命周期，却产生不同调用次数和诊断事件。必须固定错误 code/fatal 值、是否排除 origin，以及 error listener 再抛错只吞掉还是报告到宿主。

- `chunkPayloadBytes` 相同仍不足以得到唯一 DATA shape。实现 A 要求除最后一片外 payload 恰好等于 chunk size，并用 `chunkIndex * chunkPayloadBytes` 定位；实现 B 把 chunk size 只视为上限，允许多个短片并按累计长度重组。两者都按配对上限分片、使用相同 28-byte header，但 A 会把 B 的合法输出判为 invalid frame。必须规定 `chunkCount = max(1, ceil(total/chunkPayloadBytes))`、每个非末片精确长度及末片长度公式。

- ACK timeout 的“进展”未固定。实现 A 收到任何合法累计 ACK（含重复 ACK）都重启 2 秒 timer；实现 B 仅在 `nextExpectedFrameSeq > sendBase` 时重启。两者都是 2 秒 ACK timeout 和初发加三轮 Go-Back-N，但持续重复 ACK 时 A 永不重传，B 会按期重传并最终 fatal。必须明确只有累计确认前移才算 progress，重复/旧 ACK 不得延长 timeout。

- reassembly no-progress 的定义同样可分叉。实现 A 在任何语法合法 DATA 到达时重启 10 秒 timer；实现 B 仅在接受期望的连续新 frame 并写入新 payload 后重启。重复或越序流量下，一个连接可无限保留 partial buffer，另一个 fatal。必须把 progress 定义为 `nextExpectedFrameSeq`/accepted chunk 实际前移。

- 未知 operation 的首个合法 snapshot 与状态图冲突。AD-14 允许首个合法 status 创建未知 operation，AD-18 又要求重连查询可直接收到当前状态，但状态图只有 `[*] -> accepted`。实现 A 允许首个 snapshot 为 processing/terminal；实现 B 拒绝非 accepted 首帧。重连查询 terminal operation 时一个恢复成功、一个报告协议错误。必须明确“无缓存时任一协议合法 state 可作为基线 snapshot；迁移图只约束已有 snapshot 之后的更新”。

- `subscribeOperation` 和 SDK `subscribe` 的 replay/clear 合同缺失。实现 A 订阅时同步 replay 当前 snapshot，并在新 generation 清空时发布 `null`；实现 B 只通知未来 strict-newer update，清空时静默。两者都由 OperationStore 单一写入并正确清缓存，但公开调用方观察不同。必须定义初始 replay、清空/淘汰通知、取消订阅后的调用保证及 listener 调用顺序。

- “最旧 terminal”与 `currentOperation` 被淘汰后的选择仍不确定。实现 A 按 operation 首次创建时间淘汰并把 currentOperation 回退到缓存中最后应用的剩余项；实现 B 按进入 terminal 的时间淘汰并在当前项被删时设为 null。两者都优先淘汰最旧 terminal，且 currentOperation 始终是一个仍缓存的最后应用 status，但公开 state 不同。必须定义 age 基准和 current 被移除后的唯一结果。

- `sendInput(..., { operationId })` 的 busy 仲裁会破坏或允许同连接幂等重试。实现 A 对与当前 active operation 相同的显式 ID 放行，实施安全 retry；实现 B 在任何 active operation 存在时都返回 `input-busy`。两者都“显式复用 ID、检查 busy policy”，但 B 可能阻止 Response 丢失后的恢复。必须规定同 ID/same text retry 绕过 busy，还是只能断开重连后重试。

- Server 的全局幂等 claim 没有要求原子化。两个相同 `operationId/textHash` 的并发 submit 可由实现 A 在任何 await/副作用前原子 check-and-insert，因此只 enqueue 一次；实现 B 先查不存在、异步 enqueue 后再写 tombstone，两个 handler 都可能执行。静态数据规则相同，但副作用次数不同。必须规定 operation/tombstone claim、text conflict 判断和容量预留在单个同步临界区内先于 enqueue 完成。

- 重连的“当前及后续状态”订阅没有规定 snapshot 与 subscriber 安装的原子边界。实现 A 先注册 sink，再读取并发送当前 snapshot；实现 B 先发送 snapshot，再注册 sink。若 status 在两步之间更新，A 最多产生可由 revision 去重的乱序，B 永久漏掉一次更新，terminal 时尤其无法恢复。必须规定 attach subscriber 与读取 snapshot 为无丢失操作，例如先 attach、再 snapshot、全程按 revision merge。

- Server 1000 个状态 snapshot 全为 active 时没有新 operation 行为。实现 A 在接收新 ID 前返回 `operation.capacity-exhausted`；实现 B 接受并执行 job、只保留 tombstone或临时超过 snapshot 上限。两者都不淘汰 active，且 tombstone 容量可能尚有空间，但业务结果相反。必须为“无 terminal 可淘汰”的 Server status 容量单独定义拒绝码与 claim 回滚顺序。

- 重复 `session.open` 的名称作用域仍不唯一。实现 A 只采用首次名称，后续不同名称也视为幂等；实现 B 保留 peer identity但接受每次不同名称，每次实际变化各广播一次。两者都符合“名称变化只触发一次 peers 更新”，但 peers 快照不同。必须规定 clientName 是否 mutable，以及“一次”是每次值变化一次还是整个连接至多一次。

## Closed Since Previous Gate

- requestId 在 generation 内不可复用，并有固定容量。
- Request 的 first terminal signal 胜出；早到 Response 后的 send rejection 不反转结果。
- receive 不 replay、同步调用，fatal 基本顺序及 lifecycle event-before-Promise 已固定。
- 空消息 canonical DATA、配对 chunk option 和“初发之外三轮重传”已固定。
- OperationStore 已定义 unknown admission、terminal、overflow 和 currentOperation 的基本所有权。
- Server 已改为进程生命周期全局 operationId、text hash conflict、tombstone 和跨连接 retry/query。
