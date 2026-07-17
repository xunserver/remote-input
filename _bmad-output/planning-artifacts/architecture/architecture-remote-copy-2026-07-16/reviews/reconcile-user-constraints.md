# 输入约束对账报告

## 审查范围

本报告只审查 `ARCHITECTURE-SPINE.md` 对以下两类输入的忠实度，不评价代码实现质量，也不修改架构正文：

1. 用户原始意图：整体按 SDK 应用层、Session 层、Transport 层重新设计；Transport 暴露 `send`、`receive`、`connect`、`disconnect`、`state`，内部拆包并批量传输；Session 位于 Transport 之上，生成 `requestId`、维护 pending Map，并在 Response 返回时完成匹配调用。
2. 仓库根 `AGENTS.md` 中已采用的分层、协议、状态、导出和验证约束。

审查目标文件：`ARCHITECTURE-SPINE.md`（2026-07-16 draft）。

## Verdict

**CONDITIONAL PASS / 有条件通过。**

架构正文正确保留了面向使用者的三层模型，同时把 `MessageCodec` 作为 Session 内部组合端口；Transport 完整消息语义、内部拆分/跨消息窗口、requestId pending Map、Response 匹配及清理规则均已充分落地。定稿前仍需解决两项高优先级问题：operation revision 规则与根约束的直接冲突，以及 `receive()` 同时作为绑定规则、假设和延期事项所造成的公共契约不确定性。

## 用户输入逐项追踪

| 用户要求 | 结果 | 架构证据 | 说明 |
| --- | --- | --- | --- |
| 对外整体为三层 | PASS | lines 28-50, AD-1 | 明确为 SDK、Session、Transport 三层，并解释 Codec 不是使用者操作的第四层。 |
| SDK 是应用层 | PASS | AD-2, lines 278-285 | SDK 拥有 `sendInput`、operation、peer/capability、订阅和业务错误。 |
| Transport 暴露 `send/connect/disconnect/state` | PASS | lines 173-211 | 方法和只读 state 均进入结构种子；`disconect` 被正确规范为 `disconnect`。 |
| Transport 暴露 `receive` | PARTIAL | AD-6, lines 203-214, Deferred lines 473-477 | 已给出 push listener 语义，但该决定同时标为 `[ASSUMPTION]` 并延期再次评审，尚非稳定契约。 |
| Transport 根据上层完整报文拆包并批量传输 | PASS | AD-7/AD-8, lines 367-403 | 明确上层每次发送完整 `Uint8Array`，内部跨消息填充 Go-Back-N 窗口；没有误加公开 `sendBatch()`。 |
| Session 位于 Transport 之上 | PASS | Design Paradigm, AD-1/AD-3 | 依赖方向固定，Session 不感知具体 Transport 类型。 |
| Session 创建 requestId 并维护 Map | PASS | AD-4, lines 320-365 | 在发送前登记，包含并发上限、timeout 起点、disconnect/generation 清理。 |
| Response 返回后取出匹配函数 | PASS | AD-4, sequence lines 347-350 | 按相同 requestId `get/delete` 后 resolve/reject，未知或迟到 Response 不会串线。 |
| Session 接受 SDK 的 inputText | RECONCILED | AD-2/AD-3, lines 242-249 | 正文没有让通用 Session 暴露 `inputText()`，而由 SDK 映射为 typed `input.submit`。这是对根 `AGENTS.md` 分层约束的必要校正，不是遗漏。 |

## 根约束覆盖概览

### 已正确覆盖

- 固定依赖链 `RemoteInputClient -> ProtocolSession -> MessageCodec -> MessageTransport`：lines 44-50、AD-1。
- Transport 不解析业务 JSON，Codec 负责不可信输入校验：AD-5。
- 单一 `protocol:frame`、DATA/ACK wire、双向独立序号、不得回绕：AD-8、lines 396-403。
- 16 KiB、8 帧窗口、2 秒 ACK timeout、3 次重传、10 秒重组 timeout、256 KiB/128 条/4 MiB 限制：lines 383-395。
- 跨消息窗口、累计 ACK、ACK 绕过窗口、`send()` 在整条消息被 Transport ACK 后完成：AD-7、AD-8。
- Transport ACK 与 Protocol Response 分离：AD-7、Request Correlation Sequence。
- fatal 清理 Transport 资源并拒绝 pending send，Session 同时清 pending request：AD-12、Error And Cleanup Matrix。
- requestId、operationId、heartbeatId、messageId/frameSeq 命名空间隔离：AD-10。
- definitions/implementations 导出边界和 SDK/Server 组合根：AD-13。
- Client UI 不解析协议；Server 使用同一 Session/Codec：AD-2、AD-11、Source Ownership。
- 不实现或模拟 Bluetooth；真实联调只执行 `session.open`：Deferred、lines 461-471。
- 跨 workspace 测试、check 和 build：Verification Contract。

### 未完整覆盖或发生冲突

详见以下 Findings。

## Findings

### [HIGH] F-1：同 revision 替换规则直接弱化根约束

**证据**

- 根 `AGENTS.md:101`：SDK 只接受比缓存更新的 revision。
- 架构 `AD-14`（lines 132-136）：允许真实通知替换同 revision 的本地 synthetic `accepted`。

**问题**

这是一处字面且可执行行为上的冲突。若 synthetic `accepted` 被写入 `OperationStore` 并成为缓存快照，那么同 revision 的真实通知并不“比缓存更新”。实现者会在“严格 `>`”和“同 revision 特例”之间得到两种不同实现。

**建议处置**

定稿前必须二选一：

- 删除同 revision 特例，严格执行只接受更高 revision；或
- 将 synthetic accepted 明确定义为不带权威 revision 的独立 optimistic overlay，不进入服务端 revision 比较域。若选择后者，需要先更新根约束或取得明确批准，不能把例外直接写成 `[ADOPTED]`。

### [HIGH] F-2：`receive()` 同时是绑定规则、假设和 Deferred，公共端口仍可分叉

**证据**

- `AD-6`（lines 84-88）以 `[ASSUMPTION]` 规定 `receive(listener)` 为包含 message/state/error 的 push 订阅。
- Consistency Conventions line 149 又要求统一使用 `receive()`。
- Public Contracts lines 203-214 将其作为确定接口。
- Deferred lines 475-477 重新打开“message-only callback 或独立 state observable”的选择。

**问题**

用户明确要求存在 `transport.receive`，但没有决定其事件模型。当前正文一方面让实现者按统一 event union 开工，另一方面允许在实现前改变端口形状。Client Transport、Server Transport、Session 和测试 Transport 可以据此选择不兼容签名，正是 architecture spine 应防止的分叉。

**建议处置**

在定稿前确认一种模型并移除相反的 Deferred；若必须等待用户确认，则把 `receive` 形状列为阻塞 open question，不能同时进入 Binding Rule 和 Public Contract。可保留“原始 Socket.IO frame 入口必须私有”的不变量。

### [MEDIUM] F-3：公共 operation 状态语义未进入架构契约

**证据**

- 根 `AGENTS.md:88-101` 固定四种公共 state：`accepted`、`processing`、`succeeded`、`failed`；规定 `stage` 为下游专属阶段，并禁止 SDK 把 `succeeded` 解释为固定 Agent 已执行。
- 架构定义了 OperationStore 所有权和 revision 行为，却没有声明上述状态集合、`stage` 和 `succeeded` 语义。

**问题**

本次范围正是 SDK 应用层及其 operation view。缺少这些语义会允许 SDK、Server 和 UI 对成功含义或阶段字段作出不兼容解释，不能只依赖当前 TypeScript seed 隐式继承。

**建议处置**

在 operation 所有权规则或 Consistency Conventions 中加入这三项已采用约束；无需复制完整业务数据结构。

### [MEDIUM] F-4：多项新增公共行为未标为 Fast-path 假设

**证据**

- Public Contracts lines 173-201 新增 `disconnecting` 和一整套结构化 `TransportErrorCode/fatal/cause`。
- lines 251-262 新增 `createSession` 和嵌套 `session` options。
- AD-6 新增“一个 Transport 只能由一个 Session 拥有”。
- Consistency Conventions line 154 要求并发 connect/disconnect 共享 in-flight Promise，而 AD-9 line 106 又规定每次 SDK connect 创建新 Transport/Session generation。

**问题**

这些选择既不是用户原始输入，也不是根 `AGENTS.md` 已采用约束；其中连接并发规则还可能被理解为“复用当前 connect”或“后一次 connect 淘汰前一次”两种相反行为。快速架构可以作合理推断，但应标注为 `[ASSUMPTION]`，否则会被误认为继承约束。

**建议处置**

保留确有必要的设计，但逐项标明 assumption/source；明确同 target 重复 connect 与不同 target/新 generation connect 的并发语义。没有明确使用场景的错误码枚举可降为结构种子或 Deferred。

### [MEDIUM] F-5：公共 API 变更的文档/导出同步义务未进入交付约束

**证据**

- 根 `AGENTS.md:105-107` 要求公共 API 变化时同步更新 `packages/sdk/src/index.ts` 和中文 README。
- 架构 Source Ownership 只说明 `index.ts` 导出公共 API；Verification Contract 未包含 README 或导出面同步检查。

**问题**

本架构明确改变 Transport 接收方法、状态和错误类型，属于公共 API 变化。若不把同步义务放入实现交付检查，代码、类型导出和中文使用文档容易漂移。

**建议处置**

在 Verification Contract 或实现交付约束增加一项：公共 API diff 必须同步根导出测试、`packages/sdk/src/index.ts`、`packages/sdk/README.md` 及必要的中文根 README。

### [LOW] F-6：Bluetooth 被正确延期，但继承的不变量表达不足

**证据**

- 根 `AGENTS.md:48` 要求未来 BluetoothTransport 在内部承担 GATT、MTU、分片、重组、ACK 和重试。
- Deferred line 475 只说未来 story 决定具体设计；AD-1 泛化规定 Transport 内部补齐链路可靠性。

**问题**

当前不实现、不模拟 Bluetooth 是正确的，但“具体设计延期”不应让未来实现误以为可以把 MTU/分片/ACK 暴露给 Session。AD-1 大体覆盖该点，却没有保留 GATT/MTU 的明确继承约束。

**建议处置**

Deferred 中补一句：具体算法延期，但 GATT/MTU/分片/重组/ACK/重试必须封装在 BluetoothTransport 内部这一边界不可延期。

## 关键非问题

以下差异是正确的约束对账，不应在后续修改中“修回”用户原句的字面形态：

1. **Session 不直接提供 `inputText()`。** 用户描述的是数据流，根架构已固定 Session 为业务无关协议层；SDK 将文本映射为 `input.submit` 才能避免 Session 与单一业务方法耦合。
2. **Transport 接收完整 `Uint8Array`，而非 `ProtocolMessage`。** “根据上层报文拆包”应理解为对 Codec 输出的完整字节消息分片；Transport 不得解析业务 JSON。
3. **没有公开 `sendBatch()`。** “批量传输”已正确实现为 Transport 内部跨消息窗口，不改变逐消息 `send()` Promise 和消息边界。
4. **Codec 仍是独立端口。** 对使用者可称三层，但固定依赖链仍必须保留 Codec，不应为了数字上的三层把编解码塞入 Session 或 Transport。

## 定稿门槛

在 F-1 与 F-2 未解决前，不建议将 spine 状态改为 `final`。F-3 与 F-5 应作为明确继承约束补入；F-4 至少需要标出假设并消除 connect 并发语义歧义。其余用户要求与根架构约束已获得足够覆盖。
