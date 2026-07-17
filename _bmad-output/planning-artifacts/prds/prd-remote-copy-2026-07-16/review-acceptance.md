# PRD 验收可实施性评审

评审对象：`prd.md`、`addendum.md`  
评审重点：FR-1..FR-32 的原子性、可测性、一致性，以及 timeout、并发、错误、重连、包边界是否足以直接拆分 stories。

## Gate Verdict

**CHANGES REQUIRED。** 分层与主要职责已经足以进入 Architecture，但当前不能直接据此冻结 Transport/Session stories。两个 Critical 问题会改变 wire、错误语义和测试 oracle；六个 High 问题会使生命周期、协议异常、心跳和时限测试只能由实现者自行猜测。

严重度统计：**Critical 2 / High 6 / Medium 3 / Low 0**。

## Critical Findings

### AC-C01：跨 connection generation 的在途 `send` 仍是互相冲突的未决分叉

**涉及：** FR-19、FR-27、§6 非目标、§7 MVP、§9 风险、§10 开放问题 1、假设索引 FR-27；addendum §3.2、§6。

- FR-27 和 MVP/非目标实际上采用了“旧 generation 的未完成 `send` 全部失败，新 generation 只服务新消息”。
- FR-19 又要求 Transport 自行重连和 Delivery 重发，而开放问题 1 明确表示该选择尚未确认。
- 三种状态同时存在：当前要求、`[ASSUMPTION]`、定稿前必须回答的开放问题。Story 无法据此确定断线时是 reject、跨连接继续，还是重新排队。
- 该选择还决定新 Server Session 是否可能在 `session.open` 前收到旧业务 Request，以及是否需要跨连接 request/message 去重。

**必须修订：** 在定稿前选择一种语义并让所有章节一致。若保持当前 wire，建议固定为：generation 结束时，旧 generation 所有未完成 `send` 以 `delivery-unknown` 终结；新 generation 只处理断线后新接纳的消息；不跨 generation 重放。若选择同一个 `send` 跨连接继续，则必须把 logical connection resume、Server 状态保留、跨连接 ACK/去重和 `session.open` 排序纳入范围，不能只作为 Transport 内部细节。

### AC-C02：`send` reject 后“对端不会迟到交付”的保证在当前 DATA/ACK 协议下不可实现

**涉及：** FR-18、FR-21、FR-22、SM-3、NFR §5.1；addendum §5.2-§5.3、§11。

接收端可能已重组并向 Session 交付完整消息，但最终累计 ACK 丢失；发送端重试耗尽后才 reject。发送端可以保证 reject 后不再主动 emit/retry，却无法撤回已发出的 frame，也无法证明对端此前没有交付。Socket.IO 断线时在途 event 的接收结果同样可能未知。

因此以下 oracle 过强：

- “Client 已收到失败后不会再观察到该消息对应的迟到交付”；
- “每个失败 `send` 之后零迟到 frame/交付”；
- addendum 中 reject 后保证“以后绝不再发送或交付”。

**必须修订：** 把 Failure Finality 限定为本地可控行为：Promise 只 settle 一次，Transport 从 reject 时起不再主动发送/重传该消息，并释放本地状态。错误至少区分 `not-delivered`（接纳前的 call-local 拒绝）与 `delivery-unknown`（已经可能发出数据后的连接级失败）。明确 Transport failure 不保证远端业务未执行；业务去重由 `operationId`/应用协议承担。若产品坚持“reject 意味着远端绝未交付”，需要新增交付提交协议并重新审视可达保证，不能沿用当前单阶段 DATA/ACK。

## High Findings

### AC-H01：生命周期与重连 admission matrix 缺失，FR-4/5/6/19/20 无法形成确定测试

**涉及：** FR-4 至 FR-6、FR-19、FR-20、开放问题 3；addendum §2、§3、§13.2-§13.4。

当前未规定：

- `send` 在 idle、connecting、connected、reconnecting、显式 closed、恢复耗尽状态下分别排队、触发连接还是立即失败；
- 自动重连耗尽后，新 `send` 是否重新启动恢复，还是必须再次显式 `connect()`；
- connect、disconnect、后台 reconnect 和新 send 并发时哪个意图获胜；
- Client 如何无竞态地识别新的 generation，并对每个 generation 恰好执行一次 `session.open`。

**必须修订：** 在 Architecture/Story 前给出行为级状态转移表，至少包含 state、触发事件、允许操作、Promise 结果、是否接纳新消息、是否发布 generation token。名称可以留给 Architecture，行为不能继续留空。

### AC-H02：FR-20 的统一 Managed Transport 与 FR-28 的被动 Server Transport 能力冲突

**涉及：** FR-20、FR-24、FR-28；addendum §2、§7。

FR-20 要求 Managed Transport 向 Client 或 Server 组合根都提供显式 `connect()`；FR-28 又规定 Server Transport 只能包装 accepted Socket，不能主动连接。当前无法判断 Server 的 `connect()` 是禁止、无操作、返回当前状态，还是根本不存在。

**必须修订：** 将数据面与生命周期面进一步按能力拆分，例如 `SessionTransportPort`、`ActiveClientTransport` 和 `AcceptedServerTransport`；或者明确 Server `connect()` 的唯一合法语义及失败行为。不要把主动建链能力强加给被动 accepted transport。

### AC-H03：FR-12/FR-13 只说“确定行为”，没有定义协议异常的实际结果

**涉及：** FR-12、FR-13、NFR §5.4、验证门槛 §5.5。

未注册 method、未知/重复/迟到 Response、非法 Pong、非法 envelope/body、handler 抛错分别是忽略、回 ProtocolError、通知观察者、关闭 Session，还是仅记录诊断，没有明确。测试无法写出 expected result，双端实现也可能分叉。

**必须修订：** 增加协议行为表，逐项固定本地调用结果、是否回包、是否继续处理后续消息、是否触发诊断。尤其区分“可关联的非法 Request”和“无法安全关联的非法字节”。

### AC-H04：Heartbeat 只有消息类型，没有 deadline、失效语义和 Client 传播契约

**涉及：** FR-12、FR-14、开放问题 4、验证门槛 §5.5；addendum §1、§3.1、§4.4、§13.5。

PRD 声明 Session 拥有 Ping/Pong，Client 初次 open 后启动 heartbeat，但没有规定谁启动/停止、同一时刻允许几个 heartbeat、Pong deadline、非法/迟到 Pong、heartbeat failure 是否只失败 heartbeat 还是改变 Client ready。该缺口无法拆出完整 Session heartbeat 与 SDK 状态 stories。

**必须修订：** 固定最小可观察语义和测试矩阵；具体 interval 默认值可由 Architecture 配置，但 failure 对 Session 调用、Client ready 和 Transport 的影响必须由 PRD决定。

### AC-H05：FR-19/FR-23 要求“有限预算”，但缺少连接、恢复和队列等待的可测 deadline

**涉及：** FR-19、FR-23、NFR §5.2；addendum §8.4、§13.3。

附录只固定 ACK 2 秒、重传 3 轮、重组 10 秒，没有固定 connect attempt、reconnect 总预算、backoff、排队等待或整条 `send` 的最大存活时间。因而“不会永久 pending”无法用虚拟时钟给出完成上界，也无法断言应该返回哪种错误。

**必须修订：** 指定默认值或明确的配置项与总预算计算，并为 connect failure、reconnect exhausted、queue deadline、ACK retry exhausted 固定结构化错误 code。测试应证明每条已接纳 `send` 在成功或某个有限上界内 settle。

### AC-H06：FR-17 将跨消息窗口写成可选项，弱于仓库的强制互操作约束

**涉及：** FR-17、FR-25、SM-3；addendum §5.1、§8.5。

FR-17 使用“Transport 可以让多条排队消息共同有效利用容量”，允许实现完全按消息串行；仓库约束和附录则要求发送窗口允许跨消息。两种实现会产生不同的 wire 调度与性能测试。

**必须修订：** 对本次 Socket.IO Transport 明确“窗口必须允许跨消息，但 frame 提交顺序和完整消息上行顺序不变”；通用 Transport port 不必暴露该机制。

## Medium Findings

### AC-M01：Response 早于 `send` settle 的竞态只覆盖 late failure，未覆盖 late success/timer 安装

**涉及：** FR-8、FR-10、FR-11；addendum §4.1。

Response 可先完成并删除 Pending entry。随后 `send` resolve 时不得再启动 Response timer，也不得访问已释放 entry；dispose 与该回调并发时也应无副作用。

**建议修订：** 增加验收：Response/ProtocolError 已完成 Request 后，迟到的 send resolve/reject 均为无操作；Response timer 只在 entry 仍 pending 时创建；所有竞态最多 settle 一次且无 timer 泄漏。

### AC-M02：FR-2、FR-14、FR-32 不是单一能力，直接映射 story 会过大或丢验收

**涉及：** FR-2、FR-14、FR-32。

- FR-2 同时包含 connect、disconnect、input、query、notification subscription；
- FR-14 同时包含窄端口、单消费者、disconnect 无感、dispose、Pending 上限；
- FR-32 同时覆盖所有 workspace、exports、测试替身、文档和兼容策略。

**建议修订：** 保留稳定 FR ID 作为 feature group，但给验收分配子 ID（如 FR-14.a..e），或拆成新增全局 FR；Story 必须引用到单个子验收，不应只写“实现 FR-32”。

### AC-M03：SM cross-reference 过宽且存在一处清理语义歧义

**涉及：** SM-2、SM-3、SM-4、FR-7、FR-13、FR-14。

- SM-2 声称验证 FR-8..12，但指标只衡量并发 Response 关联，无法证明 Notification/Ping/Pong 等 FR-12；FR-7 和 FR-13 没有成功指标映射。
- SM-3 用一个交付指标笼统声称覆盖 FR-15..28，无法证明 lifecycle listener、资源限制、双端组合等不同能力，且包含 AC-C02 的不可实现 oracle。
- SM-4 若把“disconnect 测试结束”理解为断线事件后立即检查，则与 FR-14“已交付 Pending 等 Response timeout”冲突。

**建议修订：** 按 Session correlation、protocol validation、Transport delivery、lifecycle/recovery、resource cleanup 拆分指标；SM-4 明确在对应 Response deadline、send rejection 或 dispose 收敛后的 quiescent point 检查。

## FR-by-FR Story Readiness

| FR | 结论 | 主要阻塞/注意 |
| --- | --- | --- |
| FR-1 | Ready | 注入与依赖图可测 |
| FR-2 | Conditional | AC-M02；需拆 API 子验收 |
| FR-3 | Ready | Browser/Server 消费图可测 |
| FR-4 | Blocked | AC-H01；生命周期行为未固定 |
| FR-5 | Blocked | AC-C01、AC-H01；generation/open 信号未固定 |
| FR-6 | Blocked | AC-H01；并发 connect/disconnect/reconnect matrix 缺失 |
| FR-7 | Ready | 需在 SM 中补映射 |
| FR-8 | Conditional | AC-M01；早到 Response 竞态需补全 |
| FR-9 | Ready | 并发提交与逆序 Response 可测 |
| FR-10 | Conditional | AC-M01；timer 安装/清理竞态需补全 |
| FR-11 | Conditional | AC-C02、AC-H05；Delivery 错误语义需收敛 |
| FR-12 | Blocked | AC-H03、AC-H04；异常与 heartbeat 行为未定义 |
| FR-13 | Blocked | AC-H03；非法输入结果未定义 |
| FR-14 | Conditional | AC-H04、AC-M02；dispose/heartbeat/子验收待固定 |
| FR-15 | Ready | 空消息/最大消息边界由附录锁定 |
| FR-16 | Ready | 单 generation 顺序与边界可测 |
| FR-17 | Conditional | AC-H06；跨消息窗口必须从“可”改为“必须” |
| FR-18 | Blocked | AC-C02；失败交付 oracle 不可实现 |
| FR-19 | Blocked | AC-C01、AC-H01、AC-H05 |
| FR-20 | Blocked | AC-H01、AC-H02 |
| FR-21 | Blocked | AC-C02；需限定本地 Failure Finality |
| FR-22 | Conditional | AC-C02、AC-H05；需区分 not-delivered/delivery-unknown |
| FR-23 | Conditional | AC-H05；缺少有限上界与错误 code |
| FR-24 | Ready | 双端互操作可测 |
| FR-25 | Ready | wire/chunk/ACK 测试可由附录驱动 |
| FR-26 | Ready | 单事件与 wire version 可测 |
| FR-27 | Blocked | AC-C01、AC-C02；跨 generation 选择未确认 |
| FR-28 | Blocked | AC-H02；被动生命周期契约未固定 |
| FR-29 | Ready | artifact graph 可由 Architecture 固定 |
| FR-30 | Ready | export boundary 可由 Architecture 固定 |
| FR-31 | Ready | Operation/revision 回归可测 |
| FR-32 | Conditional | AC-M02；需拆迁移子验收 |

汇总：**Ready 12 / Conditional 9 / Blocked 11**。这不是要求把所有 TypeScript 名称提前塞回 PRD；要求的是先固定调用方可观察的状态、结果和边界，名称与物理布局仍可由 Architecture 决定。

## Assumption / SM Cross-reference Audit

| 项 | 状态 | 结论 |
| --- | --- | --- |
| FR-5 assumption | Indexed but unresolved | 已进入假设索引，但依赖 OQ-3 的 generation/lifecycle 信号，不能直接验收 |
| FR-14 assumption | Indexed, acceptable for Architecture | dispose 能力已明确，方法名可后置；heartbeat 行为不可后置 |
| FR-27 assumption | Phase blocker | 同时与 OQ-1、MVP/非目标并存，必须升级为正式决定或改写范围 |
| FR-32 assumption | Indexed, acceptable for Architecture | `inputText` 已定；订阅与兼容策略仍需在 Epics 前冻结 |
| SM-1 | Mostly aligned | 覆盖组合与 Client boundary；FR-4/5/6 仍受生命周期缺口阻塞 |
| SM-2 | Mis-scoped | 只证明 FR-8/9/部分 10/11，不能证明 FR-12；遗漏 FR-7/13 |
| SM-3 | Invalid until C02 fixed | 覆盖范围过宽且含不可实现的“reject 后零远端交付” |
| SM-4 | Ambiguous | 必须明确 cleanup 的 quiescent point，避免与 FR-14 冲突 |
| SM-5 | Aligned after Architecture | 待 package/API migration ledger 冻结后可测 |

## Recommended Resolution Order

1. 先确认 AC-C01 的跨 generation 语义。
2. 立即修正 AC-C02 的 Delivery Failure/unknown 保证和 SM-3 oracle。
3. 固定 active Client Transport 的 lifecycle/admission matrix，并拆开被动 Server Transport 能力。
4. 补齐 Session 协议异常与 heartbeat 行为表。
5. 固定有限预算、错误类别和竞态测试；再拆 Epics/Stories。
6. Architecture 冻结接口名称、package graph 与 exports 后，回填 FR 子验收引用。
