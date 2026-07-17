## Document Summary

- **Purpose:** 为 Architecture、Epics 和 Story 提供可实现、可验证的 Client、Session、Transport 产品契约。
- **Audience:** 架构师，以及 SDK、Protocol、Transport、Server 实现者。
- **Reader type:** LLM；采用 dependency-first、术语一致、结构化表达和单一事实源原则。
- **Structure model:** Strategic/Context（Pyramid），并在功能需求内部采用 Reference/Database 的一致 FR schema。
- **Core question:** Client、Session、Codec 与 Transport 分别拥有哪些职责、完成与失败语义，以及当前 Socket.IO 版本必须满足哪些验收边界？
- **Existence statement:** This document exists to help 架构师与各层实现者在不重新混合职责的前提下完成一致的架构、Story 拆分、实现和验收。
- **Current length:** 2,278 个空白分隔词项、20,125 个字符，共 12 个一级章节、18 个二级子章节和 32 条 FR。

## Structural Map

| 一级章节 | 词项数 | 直接服务文档目的 | 结构判断 |
| --- | ---: | --- | --- |
| 0. 文档目的 | 13 | 是 | 简洁说明正文与技术附录的边界，应保留。 |
| 1. 产品愿景 | 31 | 是 | 已前置核心分层结论，符合 Pyramid。 |
| 2. 目标用户与工作任务 | 122 | 是 | Browser/Server/Transport 消费路径必要，但 UJ-1、UJ-2 与前述任务有重复。 |
| 3. 术语 | 106 | 是 | 在首次使用前定义关键语义，符合 LLM dependency-first。 |
| 4. 功能需求 | 1,361 | 是 | 文档主干；五组职责边界和统一 FR schema 适合随机访问。 |
| 5. 跨功能需求 | 287 | 是 | 验证门槛和异常矩阵有独立价值；5.1-5.3 与 FR 有较多重复。 |
| 6. 非目标 | 46 | 是 | 范围护栏必要，但与 7.2、8.2 部分重复。 |
| 7. MVP 范围 | 60 | 是 | 必须在实现者阅读详细 FR 前出现。 |
| 8. 成功指标 | 97 | 是 | 提供 Definition of Done 和 FR 追踪，位置基本合理。 |
| 9. 风险与护栏 | 52 | 是 | 把关键架构风险集中呈现，应保留。 |
| 10. 开放问题 | 29 | 是 | 明确 Architecture 必须定型的命名和发布事项，应保留。 |
| 11. 假设索引 | 16 | 是 | 明确唯一非阻塞假设，应保留。 |

## Recommendations

### 1. MOVE - 将 MVP 范围提前到功能需求之前

**Rationale:** LLM 在处理 32 条详细 FR 前应先获得明确的本次包含与排除边界，尤其要先知道 Bluetooth、跨连接 resume 和持久消息队列不在范围内。
**Impact:** 约 0 词；建议顺序为“愿景 → 用户/消费路径 → 范围 → 术语 → 功能需求”。

### 2. MERGE - 合并“非目标”“MVP 范围”和“反指标”中的重复护栏

**Rationale:** Bluetooth/WebSocket、跨连接重放、双接口兼容和 Session 不拥有传输状态等边界目前在 6、7.2、8.2 多次表达，合并为一个 MECE 的“包含 / 不包含 / 禁止实现方式”表可避免下游摘录时形成多个事实源。
**Impact:** 预计减少约 45-65 词，不删除任何约束；成功指标章节只保留可测量的 SM，不再承担范围说明。

### 3. MOVE - 将协议异常行为表移到 FR-12 后

**Rationale:** FR-12 首次规定未注册 method、重复 Request、迟到 Response 和非法 Pong，却前向引用后置的 §5.4；将该表紧邻 FR-12 可满足 dependency-first，并让 Session Story 无需跨章节拼装规范。
**Impact:** 约 0 词；§5.4 仅保留跨层错误分类、cause 保留和可观测性规则。

### 4. CONDENSE - 把 §5.1 至 §5.3 改为“全局约束到 FR”的追踪表

**Rationale:** 最多完成一次、Response 不串配、消息不部分交付、默认 timeout/资源上限及可替换性已经在 FR-8 至 FR-23 中规范，后置重复正文会增加修改漂移风险；保留全局约束名称并链接权威 FR 即可。
**Impact:** 预计减少约 50-70 词，同时提升单一事实源和机器追踪性。

### 5. MERGE - 将用户任务与 UJ-1/UJ-2 合并为消费路径矩阵

**Rationale:** Browser、Server 和 Transport 实现者的“安装什么、创建什么、不得依赖什么”适合统一矩阵；UJ-1/UJ-2 基本重复这些信息，而 UJ-3 的并发与失败场景具有独立验收价值，应单独保留。
**Impact:** 预计减少约 25-40 词，并让三种消费路径可逐字段比较。

### 6. PRESERVE - 保留术语章节、五组 FR 结构、验证门槛与技术附录边界

**Rationale:** 这些元素分别提供依赖前置、MECE 职责分组、Definition of Done 和产品契约/实现规格分离，是当前文档最强的结构骨架，不应为缩短篇幅而移除。
**Impact:** 约 0 词；保留会维持下游 LLM 的理解和追踪稳定性。

## Flow Analysis

- 当前主路径“目的 → 愿景 → 用户 → 术语 → FR → NFR → 范围 → 验收”整体连贯，但范围出现得偏晚；详细需求之前仅由愿景短暂说明 Socket.IO 当前范围。
- FR 内部顺序正确：Client 组合依赖先于 Session，Session 先于 Transport，通用 Transport 先于 Socket.IO 实现，最后再进入发布迁移。
- 唯一明显的 premature/late dependency 是 FR-12 对 §5.4 异常矩阵的前向引用。
- `addendum.md` 的外置边界有效，没有把 wire layout、窗口算法等 Architecture 细节塞回 PRD 正文。
- 开放问题与假设放在结尾合理；它们不是已确认行为，不应混入 FR。Architecture 启动时应显式读取这两节。

## Summary

- **Total recommendations:** 6（5 项结构调整，1 项明确保留）。
- **Estimated reduction:** 约 120-175 词（原文约 5%-8%），主要来自真重复，不以删减需求为目标。
- **Meets length target:** 是；目标没有要求固定比例删减，只要求减少真重复。
- **Comprehension trade-offs:** 无实质信息损失；合并范围护栏时必须保留“禁止实现方式”和“本次不包含”的语义差别，不能把反指标简单删除。
- **Overall verdict:** 文档结构整体 sound，可直接支撑 Architecture；以上建议主要降低重复和跨章节跳转，不要求重写功能需求主干。
