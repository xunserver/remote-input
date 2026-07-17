# 输入对账：当前任务最新架构讨论

## 对账范围

- **原始输入：** 当前任务中关于 Client、Session、Transport 的最新连续讨论
- **目标产物：** `prd.md`、`addendum.md`
- **检查重点：** 实例注入、Session `send/receive` 窄端口、Response timeout、Transport reconnect/finality、并发 Request、Client 生命周期观察

## 结论

主体分层已经准确落地，但当前产物仍有 **1 个阻断级内部冲突、2 个未经确认却被写成具体机制的语义，以及 1 个会改变并发调用失败范围的未确认决定**。在这些问题解决前，不宜把 PRD 标记为 `final`，也不宜据此冻结 Architecture。

## 已准确落地

| 用户决定 | 落地情况 |
| --- | --- |
| Browser 创建具体 Transport 实例并注入 SDK Client | 已落地：PRD FR-1；addendum §3 示例不再使用 Transport factory |
| Session 面向 Transport 只有完整消息 `send` 和 `receive` | 已落地：PRD FR-14、FR-15；addendum §2 |
| Session 不读取 Transport state，不负责 connect/disconnect/reconnect | 已落地：PRD FR-14、FR-19；addendum §§1-4 |
| Session 拥有 `requestId`、Pending Request Map 和 Request Response timeout | 已落地：PRD FR-7 至 FR-11；addendum §4 |
| 后续 Request 不被 Session 扣住，而是立即提交 Transport | 已落地：PRD FR-9、FR-17；addendum §§4.2、5.1 |
| `send` 失败由 Transport 判定且具有最终性，失败后不得偷偷复活消息 | 已落地：PRD FR-18、FR-21；addendum §§5.2、5.3 |

## Gaps

### GAP-1 — 阻断：同一次 `send` 能否跨底层重连继续交付，正文互相矛盾

用户明确表达的是：Transport 内部负责连接、重连和重发；只有在其内部多次尝试后仍无法交付，才 reject 该消息；一旦 reject，之后绝不再发送。

PRD FR-19 与此一致，要求 Transport 处理“意外断线恢复和同一次交付预算内的重发”。但 FR-27 又假设底层连接结束时立即失败旧 generation 的全部未完成 `send`，自动重连只服务之后的新消息。addendum §3.2、§6 也采用后一种语义。

这两种契约不能同时成立：

- **允许在途 `send` 跨连接继续：** Transport 需要跨 Socket 的消息身份、接收端状态/去重或 resume 规则，才能避免远端已收但 ACK 丢失造成重复交付。
- **连接结束即失败所有在途 `send`：** 重连只恢复后续调用，不是用户所说的“同一消息由 Transport 内部重连、重发直到最终判定失败”。

必须让用户确认其中一个模型，再统一 FR-19、FR-27、风险与 addendum §§3.2、6。不能只把后一模型保留为 `[ASSUMPTION]`，因为它直接改变 `send()` 的核心完成语义。

### GAP-2 — 高：Response timeout 的起点和竞态规则尚未由用户确认

用户确认了 Session 存在“等待相同 `requestId` Response”的超时，但没有确认计时从哪个时刻开始。

PRD FR-10 将“`transport.send()` 成功后开始”标记为假设；addendum §4.1 却把它作为确定发送顺序。该选择会影响：

- Transport 排队、连接和重试时间是否计入一次 `client.inputText()` 的总时限；
- `transport.send()` 长时间未完成时 Pending Request 能存活多久；
- Response 早于本地 Transport ACK、以及 Response 成功后 `send()` 又失败时，哪一个结果拥有最终权威。

需要明确 deadline 是从 Request 登记、首次调用 `send`，还是 Transport Delivery 成功开始，并明确 Response/send-failure 竞态的优先规则。否则相同公共调用在不同 Transport 下会有不同总等待语义。

### GAP-3 — 高：Client 生命周期观察被扩展成了未确认的双接口与自动握手机制

用户确认的是：Session 无需感知 Transport 状态；Client 知道所注入的 Transport，可以通过 `transport.state` 或 `transport.on` 观察生命周期。对话没有确认以下更强要求：

- Managed Transport 必须同时提供同步 `state` **和**生命周期订阅；
- Client 必须观察 connection generation；
- 每次 Transport 恢复后由 Client 自动清除 ready、重新执行 `session.open`，并在 open 前让业务 API 以 `not-ready` 失败；
- 显式 `disconnect()` 必须压制 Transport 自动恢复，直到下一次 `client.connect()`。

PRD FR-4、FR-5、FR-6、FR-20 与 addendum §3 已把这些机制写入目标模型，其中部分虽标注 `[ASSUMPTION]`，但其余验收条款已经依赖这些假设。应先保留已确认边界：“Client 可观察生命周期，Session 不观察”，再由用户确认是 `state`、`on` 或两者，以及新连接的 `session.open` 编排和显式关闭策略。

### GAP-4 — 高：一次 chunk 重传耗尽究竟只失败该消息，还是清空全部并发 `send`，被写成了未确认的全连接失败

用户举例是“某个 chunk 多次无法交付后，Transport 报这条数据发送失败”，并要求并发 Request 都立即交给 Transport。这个表述至少确认当前消息失败，但没有确认 A 消息失败时必须同时拒绝队列中的 B、C。

PRD FR-22 和 addendum §5.4 将重传耗尽定义成 connection-fatal，并拒绝当前连接所有未完成 `send`。这会直接改变并发 Request 的可观察结果：一个大输入 A 的局部失败可能让后续查询 B 一并失败。

需确认失败作用域：

- 若 wire 序号和 Go-Back-N 使连接无法跳过 A，则应把“为什么必须连带失败 B/C”作为 Transport 契约明确说明；
- 若允许丢弃 A 后继续 B/C，则 wire 必须定义安全跳过整条消息/重置发送序列的方式。

在确认前，不应把“全部未完成 `send` 失败”描述成已经由用户决定。

## 对账建议顺序

1. 先解决 GAP-1，它决定 reconnect、generation 和跨连接可靠性模型。
2. 再解决 GAP-4，它决定并发队列在连接级故障下的失败范围。
3. 明确 GAP-2 的 Response deadline 起点和竞态终局。
4. 最后冻结 GAP-3 的 Client lifecycle API 与 `session.open` 编排。

