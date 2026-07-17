# PRD Quality Review — Client、Session 与 Socket.IO Transport 分层重构

## Overall verdict

这份 PRD 已经形成清晰且可执行的分层主张：Client、Session、Codec 与 Transport 的唯一职责、并发关联、失败最终性和 brownfield 迁移范围彼此一致，大多数 FR 也有可验证后果。当前尚不适合作为“无条件进入 Story 实现”的最终输入，因为跨连接在途消息、断线期间新 `send` 的准入以及关键 deadline 仍未闭合；先解决这些高影响契约后，可以进入 Architecture 并随后拆分 Stories。

## Decision-readiness — adequate

核心架构选择没有被写成中性的“考虑项”：§1 明确提出每层只有一个所有者，§6 非目标排除了 Channel、Session 重连和跨失败重放，附录 §12 也保存了被否决方案及理由。这让决策者能够理解选择了什么，以及主动放弃了什么。

但一项直接决定 Delivery 语义的选择仍同时以“当前默认”“假设”和开放问题出现。它不是普通 Architecture 细节，而是影响断线时 `send()` 成败、是否可能重复执行以及 Transport 测试预期的产品契约。

### Findings

- **[high]** 跨连接在途消息仍是未决的核心语义（§4.3 FR-19、§4.4 FR-27、§7.2、§9、§10 问题 1；附录 §6）——正文多处按“不跨连接 resume、旧 generation 未完成 `send` 全部失败”编写，但 FR-27 仍以 `[ASSUMPTION]` 标注，开放问题又明确要求定稿前确认。Architecture 无法在不改变 PRD 行为的前提下自行选择另一答案。*Fix:* 将“不跨连接 resume”确认成正式决定并移除假设/开放问题，或把 resume 所需 logical connection、跨连接 ACK/去重和 Server 状态保留纳入范围并重写相关 FR。
- **[medium]** 公共 API 迁移的验收条件与开放状态冲突（§4.5 FR-32、§7.2、§10 问题 5）——FR-32 要求 `sendInput`、订阅 API 和旧接口的兼容/移除策略“被明确记录”，但正文尚未记录该策略，只声明不长期兼容并把最终名称留给 Architecture。由此无法判断一次性迁移何时算完成。*Fix:* 在 PRD 中决定 breaking removal、短期 deprecated alias 或其他明确策略；具体 TypeScript 签名可以继续交给 Architecture。

## Substance over theater — strong

内容与该技术能力重构高度相关，没有装饰性 persona、虚构创新或通用 NFR。三个 Journey 分别驱动 Browser 组合、Server 对端和并发失败设计；资源上限、ACK 语义、失败范围与迁移 Ledger 都能追溯到具体实现风险。技术机制被放入附录，正文保留调用方可依赖的能力，信息层次合理。

## Strategic coherence — strong

PRD 的 thesis 是“应用语义、协议关联、链路可靠性各有唯一所有者”，FR-1 至 FR-32、非目标和风险护栏都围绕这个判断展开。MVP 是一致的平台重构范围，而不是零散 backlog；SM-1 至 SM-5 分别验证组合边界、并发关联、可靠交付、资源清理和原子迁移，反指标也直接防止通过跨层状态和双重队列取得假稳定。

## Done-ness clarity — adequate

大部分 FR 都带有可观察结果，ID 连续，成功/失败、消息边界和资源清理可以直接转成测试。尤其 FR-8 至 FR-11、FR-15 至 FR-18、FR-21 至 FR-28 对竞态和失败最终性的描述足够具体。

关键生命周期场景仍缺少可测边界。PRD 要求所有等待都有有限预算，却没有给 Session Response、连接建立、重连总预算或断线期间排队的默认期限；同时允许后台恢复和按需恢复都作为配置，却没有固定新 `send()` 在 disconnected/reconnecting 时是排队还是立即失败。

### Findings

- **[high]** 关键 deadline 只有“有限”要求，没有默认值或最大边界（§4.2 FR-10、§4.3 FR-19/FR-23、§5.2；附录 §8.4）——附录锁定了 ACK 2 秒、重传 3 轮和重组 10 秒，却没有锁定 Response timeout、连接尝试、重连总预算及 disconnected queue wait。测试无法证明 `send()` 和 Request 不会永久 pending，也无法验证默认用户体验。*Fix:* 为每类 deadline 给出默认值、是否可配置以及允许范围；至少定义一个端到端上界或明确各阶段如何组成总预算。
- **[high]** disconnected/reconnecting 状态下新 `send()` 的准入语义未定义（§4.1 FR-5、§4.3 FR-19/FR-20、§4.4 FR-27；附录 §3.2/§6）——旧 generation 的在途消息如何处理已有安全默认，但连接已经断开或正在恢复时新提交的消息究竟排队等待、触发按需连接还是立即失败没有权威规则。FR-19 允许不同恢复策略，却要求调用者观察到一致语义，当前没有定义这份一致性。*Fix:* 按 Transport state 列出 `send()` 的准入、排队、失败和预算规则，并说明 Client not-ready gate 与直接 Session 使用路径各自如何表现。
- **[medium]** 协议异常只要求“确定行为”，没有给出行为本身（§4.2 FR-12、§5.5）——未注册 method、未知/重复/迟到 Response、非法 Pong 和 handler 异常可能被忽略、记录、返回 ProtocolError 或终止会话，当前实现者仍需自行选择。不同实现可能因此不互操作。*Fix:* 增加紧凑的异常行为表，逐类固定 ignore、respond-error、reject-local、diagnostic 或 dispose/close 的结果。

## Scope honesty — strong

§6 和 §7.2 对 Bluetooth、WebSocket、跨 Socket resume、认证、持久队列及旧接口长期兼容都作了明确排除，没有用抽象的“未来可扩展”暗中扩大交付。四个 `[ASSUMPTION]` 均在 §11 往返索引，开放问题也区分了 PRD blocker 与可由 Architecture 固定的项目。范围的不确定性被诚实暴露，问题在于其中一个 blocker 尚未解决，而不是被隐藏。

## Downstream usability — adequate

术语表覆盖关键领域名词，FR-1 至 FR-32、UJ-1 至 UJ-3、SM-1 至 SM-5 均连续且唯一，正文交叉引用能够解析；Journey 均有具名主人公。附录提供接口 seed、wire、迁移 Ledger 和 rejected alternatives，Architecture 可以稳定抽取多数输入。

仍有两处跨章节的所有权或错误契约不足，会让 Architecture 和 Stories 在没有产品决定的情况下补写行为。

### Findings

- **[medium]** heartbeat 的触发者与失败传播尚未形成唯一所有者（§1、§3 Session 定义、§4.2 FR-12、§10 问题 4；附录 §3.1/§4.4/§13）——正文把 Ping/Pong 和 heartbeat 放在 Session，附录初次连接流程却写成 Client “启动应用所需 heartbeat”，随后又把 heartbeat failure 传播留作开放问题。实现者无法判断 Client 是调用 Session 的显式 heartbeat 生命周期，还是 Session 自治。*Fix:* 固定 heartbeat 的启动、停止、deadline 和 failure owner；Client 只消费其应用状态投影，或明确它需要调用的 Session 生命周期 API。
- **[medium]** 错误类别已列出但公共错误契约不足以拆 Story（§4.2 FR-7/FR-11、§4.3 FR-23、§5.4；附录 §5.4/§13）——PRD 要求区分连接失败、Delivery Failure、Response Timeout、ProtocolError、校验失败和 Operation failure，但未说明哪些 Client/Session API 会产生哪些类别、稳定 code 与 retryability 如何保留。仅把错误码映射交给 Architecture，容易让测试、SDK 和 Server 分别定义。*Fix:* 在 PRD 增加面向调用者的错误矩阵，固定类别、来源、影响范围和可重试语义；具体类名与 TypeScript 结构留给 Architecture。

## Shape fit — strong

这是高集成密度的 brownfield 技术能力 PRD，并将继续馈送 Architecture 和 Stories；以 capability/contract 为主、辅以三个紧凑 Journey 的形状合适。附录承担 wire、接口草图和迁移事实，正文没有被实现细节淹没；同时 brownfield Ledger 明确列出当前到目标的变化，没有把项目伪装成 greenfield。

## Mechanical notes

- Glossary 用词总体稳定，`Request`、`Pending Request`、`Transport Message`、`Transport Delivery` 和 `Connection Generation` 在正文与附录中含义一致。
- FR、UJ、SM ID 连续且无重复；FR-19 对 FR-27 的引用可解析。
- 四个 inline `[ASSUMPTION]` 均出现在 §11 假设索引，索引没有悬空项。
- 有三处轻微排版粘连：FR-9 的“Response或”、附录 §4.3 的“Pending Request立即”和附录 §5.4 的“Request独立”；不影响语义，可在最终 prose polish 时修复。
