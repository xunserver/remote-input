## Document Summary

- **Purpose:** 保存 PRD 下游 Architecture 所需的技术机制、wire、状态机、迁移事实与方案取舍。
- **Audience:** 架构师和实现者。
- **Reader type:** LLM；采用依赖优先、术语一致、结构化表达和单一事实源原则。
- **Structure model:** Explanation（Conceptual），以 Architecture reference 的随机访问需求作为次要约束。
- **Core question:** Client、Session、Codec 与 Transport 的职责、运行机制、连接恢复、交付语义、Socket.IO wire 和 brownfield 迁移应如何被 Architecture 固化？
- **Existence statement:** This document exists to help 架构师和实现者将已确认的 Client、Session、Transport 架构转化为一致、可实现、可测试的 Architecture 契约。
- **Current length:** 约 1,875 个空格分隔词、439 行，共 32 个内容章节（13 个主章节、19 个子章节）。

## Structure Map

| 主章节 | 约计词数 | 是否直接服务目的 | 结构判断 |
| --- | ---: | --- | --- |
| 1. 最新分层模型 | 116 | 是 | 正确承担总览和职责脚手架，应保留在首位 |
| 2. 两个 Transport 能力面 | 113 | 是 | 必要契约 seed，但与第 7 节重复主动端/被动端差异 |
| 3. Client 组合与连接流程 | 203 | 是 | 初次连接顺序清晰；异常恢复和显式关闭与第 5、6 节分散描述同一状态机 |
| 4. Session 请求关联机制 | 387 | 是 | 依赖顺序基本正确，完整覆盖 pending、并发、异常、heartbeat 与释放 |
| 5. Transport 队列与 Delivery 语义 | 320 | 是 | 核心参考；Promise outcome、finality 和 failure matrix 有少量重复 |
| 6. Connection Generation 边界 | 52 | 是 | 关键术语在第 3 节先被使用、后被定义，应前移或并入生命周期总表 |
| 7. 主动端与被动端 | 42 | 是 | 内容必要，但信息已在第 2 节出现，适合合并 |
| 8. Socket.IO Wire 与可靠传输 | 207 | 是 | 是实现唯一事实源，wire、限制和算法细节均应保留 |
| 9. Package 与消费边界 | 43 | 是 | 独立发布目标的必要输入，位置合理 |
| 10. Brownfield 迁移 Ledger | 139 | 是 | 必要迁移事实，与第 12 节对同一变化重复给出理由 |
| 11. Socket.IO 官方能力边界 | 42 | 是 | 是技术选择依据，但与对应机制距离较远 |
| 12. 已覆盖的旧方案 | 83 | 是 | 方案取舍属于本附录目的，可与迁移 Ledger 合成单一决策记录 |
| 13. Architecture Update 待固定 | 57 | 是 | 最重要的下游工作入口被埋在文末，应前置 |

## Recommendations

### 1. MOVE - “Architecture Update 待固定”前置到分层模型之后

**Rationale:** 下游 Architecture 必须先知道哪些内容已经确定、哪些接口名称和状态机细节仍待冻结，否则 LLM 可能把后文的概念 seed 误当成最终契约。
**Impact:** 约 0 词；建议同时把标题改为“Architecture 待固定项”，并明确“已确认约束”和“待命名/待细化项”的边界。

### 2. MERGE - 将连接生命周期、generation 与 admission 收敛为一个权威状态表

**Rationale:** 第 3.2、3.3、5.5、6 节分别描述同一连接状态机的 Client、Transport、旧请求和新请求行为，合并成 `触发 / Transport / Client / Session Pending / 新 send / generation` 表能消除跨节推断和规则漂移。
**Impact:** 约减少 35–55 词；保留第 3.1 的初次连接时序图，并让 heartbeat 和 Delivery failure 小节引用该状态表。

### 3. MERGE - 合并“两个 Transport 能力面”与“主动端与被动端”

**Rationale:** 第 2 节接口 seed 已说明主动 Client 才有 `connect()`、accepted Server 构造后已连接，第 7 节再次表达同一差异，合并后可以在概念首次出现时一次定义完整。
**Impact:** 约减少 20–30 词；建议保留 Client/Server 对照表，放在接口 seed 后。

### 4. MERGE - 将 Promise 完成、Failure Finality 与失败分类整理成单一 Delivery outcome 规范

**Rationale:** 第 5.2、5.3、5.4 对 reject 的本地终态、`not-delivered`、`delivery-unknown` 和典型原因有交叠，先定义 outcome，再用一个 failure matrix 映射原因，可以建立单一事实源而不删减约束。
**Impact:** 约减少 30–45 词；必须保留“本地 finality 不证明远端未执行”和 operationId 查询/复用规则。

### 5. MERGE - 合并 Brownfield 迁移 Ledger 与已覆盖旧方案

**Rationale:** 第 12 节七项 rejected-alternative 基本逐项重复第 10 节的当前实现与目标变化，给迁移表增加“取代原因”列即可同时保存迁移事实和方案取舍。
**Impact:** 约减少 45–65 词；不能删除 definitions、SDK、Server、Browser、测试、文档同步迁移清单。

### 6. MOVE - 将 Socket.IO 官方依据放到对应机制附近

**Rationale:** 离线缓冲、at-most-once、ack 和 connection recovery 的官方边界分别支撑 Failure Finality、generation 隔离和 wire ACK，紧邻约束引用可减少 LLM 错配论据的风险。
**Impact:** 约减少 5–10 词；可以取消独立第 11 节，但必须保留全部四个官方链接和事实边界。

### 7. PRESERVE - Socket.IO wire、默认限制、示例和协议异常表

**Rationale:** DATA/ACK 字节布局、序号边界、资源上限、GBN 规则、并发示例和异常响应不是可删的实现噪声，而是 Architecture 与测试生成所依赖的无歧义输入。
**Impact:** 0 词；即使执行其他压缩，也不应摘要化这些内容。

## Flow Assessment

- 当前总体顺序从分层到 Client、Session、Transport、wire、迁移，主干是合理的。
- 主要缺口是 `connection generation` 在第 3 节首次使用、到第 6 节才完整定义，违反 LLM reader 的 dependency-first 原则。
- 第 13 节是 Architecture 的实际工作清单，却位于所有机制和历史材料之后，构成关键内容 burying。
- 没有应整体删除的章节，也没有越出“技术机制、wire、状态机、迁移事实、方案取舍”的内容。
- 图、表和代码 seed 都在降低歧义，不属于应删的 comprehension aid。

## Summary

- **Total recommendations:** 7
- **Estimated reduction:** 约 135–205 词（约 7%–11%），主要来自真正重复；技术约束数量不减少。
- **Meets length target:** 是；目标是不以删减技术约束为目标，只减少真正重复。
- **Comprehension trade-offs:** 无预期信息损失；合并时必须逐条迁移约束，并用交叉引用代替复制。若无法保证逐条保留，应优先保留原结构而不是为压缩牺牲契约完整性。
