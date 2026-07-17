# Reviewer Gate - Adversarial Divergence

## Verdict

**FAIL - 仍存在会让两个逐字遵守全部 AD 的独立实现产生不同 Promise 结果、状态事件、operation 视图或不兼容 wire 的自由度。** 分层本身已稳定，但以下歧义必须收口后才能把 spine 当作 preservation-valid 的实现合同。

为验证发散性，审查假定两套实现都采用规定的三层边界、同一 envelope、Go-Back-N、严格 revision 合并和 Server 生命周期：实现 A 倾向同步事件、严格帧校验和 eager merge；实现 B 倾向异步事件、兼容性帧处理和延迟 merge。以下每项中，A/B 都能引用现有 AD 证明自己合规，但外部可观察结果不同。

## Findings

- AD-4 只要求 `requestId` 在“当前 pending Map”中唯一，却声称迟到 Response 不能完成另一个请求。实现 A 在整个 generation 内从不复用已完成 ID；实现 B 在 entry 删除后立即复用同一 ID。两者都满足当前文字，但 B 会让前一请求的迟到/重复 Response 完成新请求。必须规定 `requestId` 在整个 connection generation 内不可复用，或保留 tombstone 直到 generation 结束。

- 早到 Response 与稍后 `transport.send()` reject 的胜负未定义。实现 A 在 Response 到达时立即 resolve 并忽略随后 send rejection；实现 B 暂存早到 Response，等待 send resolve 后才 resolve，若 send 先 reject 则 request reject。两者都“接受早到 Response”且 entry 只完成一次，但 SDK 得到相反结果。必须规定 terminal precedence，并规定败方错误是忽略还是只发布诊断事件。

- `receive()` 没有 replay、同步性和 Promise/event happens-before 契约。实现 A 注册时立即同步 replay 当前 state，并在 `connect()` resolve 前同步发布 `connected`；实现 B 只交付未来事件，并在 connect Promise resolve 后的 microtask 发布 state。两者都是 push listener，Session 也都先注册，但 SDK 的 `connected` 状态、listener 重入和测试观察顺序不同。必须固定“无初始 replay/是否同步”，并规定 state event 必须发生在对应 lifecycle Promise resolve/reject 之前还是之后。

- fatal 只规定“各发布一次 error 和 `state=error`”，未规定二者顺序、listener 抛错时的处理以及 unsubscribe 返回后的排队回调。实现 A 发布 state 后 error；实现 B 发布 error 后 state。Session 虽幂等清理，SDK error listener 读取到的 state 不同，旧 generation 也可能在 unsubscribe 后收到 B 已排队的事件。必须规定单一顺序，并保证 `Unsubscribe` 返回后不再调用该 listener。

- `TransportErrorCode -> fatal` 没有完整映射。实现 A 把远端 `disconnected`、connect failure 和 `internal` 全设为 fatal；实现 B 只把已连接后的非法帧/timeout/耗尽设为 fatal。两者都可声称遵守 AD-12，但 Session 是否执行 generation 终止、SDK 是否清 ready 会不同。必须给每个 code 定义固定 fatal 值，并拆分无法共享语义的 `internal`/`disconnected` 场景。

- wire 没有规定可调低的 `chunkPayloadBytes` 如何互操作。实现 A 允许本地配置 4 KiB，并按本地 chunk size 校验 `chunkCount`/payload 位置；实现 B 固定按默认 16 KiB 校验。两端都使用同一 28-byte DATA header、默认 16 KiB 且遵守 AD-8，但一旦合法配置不同就互相判为非法帧。必须二选一：wire 固定 16 KiB，不允许改；或在握手/帧中协商并携带可验证的 chunk 规则。

- 空消息没有 canonical DATA 表示。实现 A 编码为 `chunkCount=1, chunkIndex=0, payloadBytes=0`；实现 B 编码为 `chunkCount=0` 的零载荷 DATA，并在接收端据此交付空 `Uint8Array`。两者都使用规定字段，Verification 又要求空消息，但 AD 未给 `chunkCount >= 1` 和空消息特例，因此同类实现互通、交叉实现 fatal。必须逐字段规定唯一编码。

- “最多重传 3 次”和 ACK timeout 的计时基准不充分。实现 A 允许初次发送加 3 个 Go-Back-N 重传轮次，并仅在累计 ACK 前进时重置 2 秒计时器；实现 B 把总发送次数限制为 3，并在任何 ACK（含重复 ACK）到达时重置。两者都可称为 3 次 max retransmissions/2 秒 no-ACK timeout，但在相同丢包序列下一个成功、一个 fatal。必须定义初次发送是否计数，以及只有 `sendBase` 前进才算 ACK progress。

- Session 本地错误仍没有共享判别 shape。实现 A 对 timeout、unknown response、invalid matched result 发带稳定 `SessionError.code` 的事件/拒绝；实现 B 只使用普通 `Error`，再由 SDK 按调用上下文映射现有错误码。两者都“转成协议级失败”并可保留 cause，但不同 SDK/自定义 Session 无法互换。必须把 SessionError 联合、每个错误的 reject/event/both 路由，以及 matched result invalid 与整条 decode invalid 的差异写入 public contract。

- AD-14 未定义更高 revision 的状态转换约束及未知 operation 的准入。实现 A 接受当前 generation 的任意 operationId，并允许 `succeeded@r3 -> processing@r4`；实现 B 只接受 SDK 已创建/pending 的 operationId，并把 terminal 回退视为协议错误。两者都只写入 strict-newer revision，也都不违反 AD-16 的 state 枚举，但缓存内容、容量压力和订阅事件不同。必须规定未知 operation 是否建档，以及 terminal 是否为 absorbing state。

- OperationStore 达到 1000 条且没有可淘汰 terminal 时没有确定动作。实现 A 拒绝缓存新的 active status；实现 B 保留新状态但暂时超过容量；两者都不淘汰 active，却分别违反“权威更新不得丢”或“最多 1000 条”的隐含期待。即使 SDK 当前 single-active，未知 notification 仍可构造该状态。必须指定 overflow 结果和稳定错误/断链策略。

- `RemoteInputState.currentOperation` 的选择函数及 Store 清空通知未定义。实现 A 选择最后提交的 operation，并在新 connect 清空时向每个 operation subscriber 发布 `null`；实现 B 选择最近 revision 更新的非 terminal operation，清空时静默取消订阅。两者都让 OperationStore 成为唯一 owner，也都清除了旧 generation，但 UI 和订阅者观察完全不同。必须定义 currentOperation 选择、初始 replay、ignored revision 是否通知，以及 generation clear 的通知顺序。

- Server 的 `(connectionId, operationId)` 去重没有 retention 合同。实现 A 只保存最近 1000 个 terminal operation，淘汰后同 ID 会再次执行输入；实现 B 保存到连接结束，保证整个连接生命周期内不重复副作用。两者使用同一去重 key，accepted job 也都断线后运行至 terminal，但业务幂等强度不兼容。必须规定 dedupe record 至少保留到连接结束，或明确有界 retention 后重放可能再次执行。

- 重复 `session.open` 的 clientName 规则仍可分叉。“幂等并保留 peer identity；名称变化只触发一次 peers 更新”允许实现 A 永久保留首次名称并忽略后续名称，也允许实现 B 接受每次不同名称且每次变化广播一次。两个 Server 都保留 identity 并避免同名重复广播，但 peer 视图不同。必须规定重复 open 的 result、名称是否可更新以及一次的作用域。

## Gate Exit Conditions

- 为 requestId generation 唯一性和 early Response/send failure precedence 增加 Session Rule 与竞态测试。
- 为 Transport 固定 lifecycle Promise/event 顺序、fatal 事件顺序、unsubscribe 保证和 code/fatal 映射。
- 为 Socket.IO 固定 chunk 配置互操作、空消息编码和 retransmission progress 计数。
- 为 OperationStore 固定准入、terminal 转换、overflow、currentOperation 和清空通知。
- 为 Server 固定 dedupe retention 与重复 open 的名称行为。
