# Client / Session / Transport 可靠性对抗评审

评审对象：`prd.md`、`addendum.md`  
评审日期：2026-07-16  
评审结论：**未通过（NOT READY）**。分层方向成立，但当前契约仍允许两个各自遵守文档的实现产生不同的公开结果；其中 ACK 丢失后的失败语义、connection generation 识别、`receive` 订阅跨重连寿命和 heartbeat/open 顺序会直接破坏可靠性或让 Client 永久无法 ready。

## 严重度统计

| Critical | High | Medium | Low | Total |
| ---: | ---: | ---: | ---: | ---: |
| 4 | 7 | 2 | 0 | 13 |

## 两个均可声称合规、但行为不兼容的实现

| 决策面 | 实现 A：后台恢复、失败优先 | 实现 B：按需恢复、排队优先 | 文档为何同时允许 |
| --- | --- | --- | --- |
| 意外断线后的恢复 | 后台立即重连；恢复期间的新 `send` 立即以 `not-connected` reject | 没有消息时不重连；恢复期间的新 `send` 触发/加入 single-flight reconnect，有限预算内等待新 generation | FR-19 明确允许“后台重连或按需恢复”，但未固定恢复期间新 `send` 的准入语义 |
| Client 识别新连接 | lifecycle event 带单调递增 `generation`；按 generation 对 `session.open` single-flight | lifecycle event 只有 `connected`；Client 以状态边沿推断新连接 | FR-5 要求每 generation open 一次，附录却把 generation 是否进入事件留给 Architecture |
| Server accepted Transport 的 `connect()` | 对已经 accepted 的 Socket 幂等 resolve | 抛出 `unsupported-operation` | FR-20 要求 Managed Transport 有 `connect()`，FR-28 又说 accepted Transport 不能主动建链，未定义调用结果 |
| `session.open` 失败 | 当前 generation 保持 connected/not-ready，等待调用者显式 disconnect/connect | Transport 主动关闭当前 generation，再自动建立下一 generation 以获得一次新的 open 机会 | “每 generation 恰好一次 open”没有规定 open 失败后的恢复动作 |
| 旧 Server Session | Socket close 时组合根立即 dispose，旧 handler 结果被丢弃 | 保留旧 Session 到 handler/Response deadline 完成，再 dispose | Session 看不到 disconnect，且 PRD 没规定 Server 组合根何时释放旧 Session |
| Response deadline | 默认 5 秒 | 默认 60 秒 | 只要求“有 deadline”，没有冻结默认值、配置入口或总调用时限 |

这不是可接受的实现自由度：A 与 B 对同一段 SDK/Server 代码分别返回成功、立即失败、延迟失败或永久 not-ready，互操作测试也无法从当前文本推出唯一期望。

## Critical

### C-1：`send` reject 不能证明对端未收到或未执行，当前 Failure Finality 过度承诺

依据：`prd.md` FR-18、FR-21、SM-3（约第 228-264、446 行），`addendum.md` §5.2-5.3（约第 199-214 行）。

攻击序列：接收端完整重组 Request，先向 Session 交付并执行 `input.submit`；最终累计 ACK 在网络中丢失；发送端重传耗尽后 reject。Transport 可以保证 reject 后不再发送任何新 frame，却无法撤销已经发生的远端交付。旧 handler 还可能随后完成并产生 Operation notification。

因此“Delivery Failure”“失败后零迟到交付”若被调用方解释为安全重试，会造成重复输入。Response 提前到达时又按 FR-11 被视为成功，说明同一 wire 事实最终由本地微任务先后决定成功或失败。

必须修正：把保证拆成两条：`reject` 后本地不再发送；交付结果可以是 `definitely-not-sent` 或 `delivery-unknown`。ACK/retry 耗尽必须至少属于 `delivery-unknown`，SDK 不得把它标成可安全重试。增加“接收端已交付、最终 ACK 全丢、发送端 reject”的互操作测试。

### C-2：Client 必须按 generation 执行 `session.open`，但 generation 不在强制生命周期契约中

依据：`prd.md` FR-5（约第 105-112 行）、FR-27（约第 313-320 行）、开放问题 3（约第 469 行）；`addendum.md` §2 第 65-71 行。

状态字符串不足以阻止 `connected(g1) -> disconnected(g1) -> connected(g2)` 中迟到的 g1 open 结果把 g2 标成 ready，也不足以在快速重连时判定两个 `connected` 是否属于同一 generation。实现 A 使用 generation token 可以正确工作；实现 B 只看状态边沿同样符合尚未冻结的接口，却会错开 open。

必须修正：Managed Transport 每次成功建链发布不可复用、严格递增的 connection generation；`connect()` 结果、connected event 和 Client ready/open attempt 都携带或绑定该 token。PRD 定稿前不能把它留给 Architecture。

### C-3：`receive` 订阅是否跨自动重连持续有效没有契约，Session 又没有重新订阅路径

依据：`prd.md` FR-14、FR-15、FR-19（约第 188-207、237-246 行）；`addendum.md` §2 第 45-63 行。

Session 只调用一次 `receive(listener)` 且看不到 disconnect。一个 Transport 可以把 listener 存在稳定对象上并在每个新 Socket 上继续投递；另一个可以把 listener 绑定当前 Socket，并在 fatal cleanup 时随 Socket 清除。接口和验收项没有明确禁止后者。第二种实现重连后所有 Response/Notification 都丢失，`session.open` 只能超时。

必须修正：明确 `receive` 注册寿命属于 Transport 对象，跨所有内部 connection generation 持续有效，直到显式 unsubscribe 或 Transport dispose；断线清理不得清除订阅。增加同一 listener 在 g1、g2 各收到一条完整消息的测试。

### C-4：Session heartbeat 对 disconnect 无感，会越过新连接的 `session.open` gate

依据：`prd.md` FR-12、FR-14（约第 170-196 行）；`addendum.md` §3.1 第 90-101 行、§4.3-4.4 第 165-182 行。

Session 拥有 Ping/Pong 和 heartbeat timer，但看不到 Transport disconnect。旧 heartbeat 可以在 Transport 恢复期间调用新 `send`；按实现 B，它会触发/排入新 generation，并可能在 Client 完成 `session.open` 前到达新 Server Session。按实现 A，它会失败，但 PRD 没规定 heartbeat failure 是否终止 timer、污染 Client 错误或等待下一 tick。

必须修正：指定 heartbeat 的生命周期控制者和严格顺序。推荐 Client 在 generation 结束时暂停 Session heartbeat，在该 generation 的 `session.open` 成功后启动；或者明确 Ping/Pong 在未 open Server Session 上合法，并固定 heartbeat send failure 行为。当前“Session 不感知断线”不能与“heartbeat 永久自行运行”同时保持含糊。

## High

### H-1：恢复期间新 `send` 是立即失败还是等待新连接未定义

依据：`prd.md` FR-19 第 239-246 行、FR-27 第 319 行。

“自动重连只服务之后新提交的消息”既可解释为断线后立即提交即可排队，也可解释为只有 connected 之后提交才接受。两者都有限预算且不重放旧 send，却给 Session 完全不同的结果。必须定义 disconnected/reconnecting 各状态下 `send` 的准入、排队和错误语义，并覆盖 connect、send、disconnect 三方并发测试。

### H-2：connection cutover 缺少线性化点，断线同时到来的并发 `send` 无法归属 generation

依据：`prd.md` FR-17、FR-19、FR-27（约第 219-246、313-320 行）。

当 Socket disconnect callback 与 `send(B)` 同一事件循环交错时，B 可以被算作旧 generation 的未完成消息而失败，也可以算作新 generation 的首条消息而等待恢复。必须规定 enqueue 时、首次 frame emit 时或 generation reservation 时哪一个是归属线性化点；fatal cleanup 只清理该点之前归属旧 generation 的 send。

### H-3：显式 disconnect 对 Pending Request 的语义与“disconnect 后无泄漏”互相冲突

依据：`prd.md` FR-14 第 195-197 行、NFR §5.2 第 383-386 行、SM-4 第 447 行；`addendum.md` §3.3 第 120-127 行。

一处要求 delivered Request 在 Transport disconnect 后继续等 Response timeout；另一处要求所有 disconnect 路径无 Pending/timer 泄漏。`client.disconnect()` 是否 dispose Session、立即取消 SDK 调用、还是等待所有 timeout 没有答案。必须分别定义“意外断线”和“显式 Client disconnect”的 pending 行为，并说明同一 Client 再 connect 时是复用还是重建 Session。

### H-4：Server accepted Socket 关闭后，旧 Session 与异步 handler 没有强制释放流程

依据：`prd.md` FR-14、FR-28（约第 188-197、322-329 行）；`addendum.md` §4.4 第 174-182 行、§7 第 239-246 行。

Server root 知道 Socket close，Session 不知道。文档没有要求 root 调用 Session dispose，也没有定义已经运行的 handler 是否允许完成副作用、是否允许尝试 Response、其 send failure 如何消费。结果是旧 listener/timer/handler 泄漏或 unhandled rejection。必须规定 accepted Transport close 后 root 的 dispose 时序，以及 dispose 后旧 handler Response 必须被抑制且错误被消费。

### H-5：Server accepted Transport 被要求实现 `connect()`，但合法行为未定义

依据：`prd.md` FR-20 第 248-255 行、FR-28 第 322-329 行。

幂等 resolve 与抛 `unsupported` 都合理，却会使通用组合根的行为不兼容。应拆成 `ActiveManagedTransport` 与 `AcceptedTransport`，或明确 accepted Transport 的初始 state、`connect()`/`disconnect()` 幂等语义和是否允许再次使用。

### H-6：`session.open` 失败后的恢复策略缺失

依据：`prd.md` FR-5 第 105-112 行、FR-28 第 324-329 行。

每 generation “恰好一次”意味着 open 的 ProtocolError/Response timeout 后不能在同 generation 重试，但文档也没有要求关闭该 connection 以获得新 generation。Client 可以永久 connected-but-not-ready。必须固定：open 失败是否终结 generation、哪些错误可在同 generation 重试，以及 `client.connect()` 在 connected/not-ready 时的行为。

### H-7：Socket.IO 离线 send buffer 可绕过失败最终性，只有原则没有可执行护栏

依据：`prd.md` FR-21、FR-26（约第 257-264、304-311 行）；`addendum.md` §11 第 350-355 行。

`socket.connected` 检查与 `socket.emit` 之间发生断线时，普通 Socket.IO Client emit 可能进入内部 `sendBuffer`；Transport 随后 reject 并清空自己的队列，Socket.IO 却在重连后发送旧 `protocol:frame`。这直接违反 Failure Finality。必须在附录锁定可验证策略（例如不允许普通离线 buffer、使用不会缓存的发送路径/新 Socket generation，并清除旧实例），并测试“emit 临界点断线 -> send reject -> reconnect 后服务端零旧 frame”。

## Medium

### M-1：Response deadline 只有起点，没有默认值、配置边界和原子启动规则

依据：`prd.md` FR-10 第 152-159 行、NFR §5.2 第 381-386 行；`addendum.md` §4.1 第 144-153 行。

5 秒与 60 秒的 Session 都合规；此外 Response 可在 `send` Promise continuation 启动 timer 前完成，粗糙实现会给已删除 entry 启动孤儿 timer。应冻结默认值/配置入口，并要求只有 entry 仍是当前 pending 时才 arm timer，任何终态都取消 timer。

### M-2：生命周期快照与订阅不是原子操作，Client 可能永久错过 connected

依据：`prd.md` FR-20 第 248-255 行；`addendum.md` §2 第 65-71 行。

Client 先读 `state` 再注册 `on`，两步之间完成连接时会漏掉 connected；先注册再读则可能重复处理。必须提供带当前 generation 的 replay/subscribe 语义或定义可去重的“订阅后读快照”算法，并做竞态测试。

## 必须在 PRD 定稿前解决的最小集合

1. 将 send reject 的保证改为“停止未来发送”，并显式建模 `delivery-unknown`。
2. 把单调 connection generation 和 lifecycle 快照/事件语义提升为强制契约。
3. 保证 `receive` listener 跨内部重连持续有效。
4. 固定 heartbeat 与 `session.open` 的 generation 顺序。
5. 固定恢复期间新 `send` 的准入和 generation cutover 线性化点。
6. 固定显式 disconnect、Server Socket close 和 Session dispose 的 pending/handler 行为。
7. 为 Socket.IO 离线 buffer 增加实现约束和故障注入验收测试。

