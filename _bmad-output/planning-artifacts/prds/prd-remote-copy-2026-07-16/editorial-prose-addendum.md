# Editorial Review - Prose: Technical Addendum

`reader_type`: `llm`

| Original Text | Revised Text | Changes |
|---------------|--------------|---------|
| 遇到 `delivery-unknown` 时，调用方先执行 `operation.get`，确认不存在后才用相同 ID 重试，不能生成新 ID 盲目重发。 | 遇到 `delivery-unknown` 时，调用方先执行 `operation.get`；确认该 Operation 不存在后，才使用相同 `operationId` 重试，不能生成新的 `operationId` 盲目重发。 | 补出“确认不存在”的对象，并统一该段中的标识符名称，避免 ID 指代不明（第 106 行）。 |
| Client 以 generation token 做 single-flight，旧 generation 的迟到结果不得更新当前 ready。 | Client 使用 generation token 保证 single-flight；旧 generation 的迟到结果不得改变当前 generation 的 ready 状态。 | 明确 single-flight 是保证关系，并明确迟到结果不得影响哪个 generation 的状态（第 122 行）。 |
| `session.open` ProtocolError、校验失败或总期限耗尽会关闭当前 generation、进入 error 并 reject，调用者之后可以再次显式 connect。 | 如果 `session.open` 返回 ProtocolError、校验失败或总期限耗尽，Client 会关闭当前 generation、进入 error 并 reject；调用者之后可以再次显式 connect。 | 补出 ProtocolError 的谓语和执行关闭动作的主体（第 122 行）。 |
| 创建本 Session 生命周期中不会危险复用的 `requestId`； | 创建一个在本 Session 生命周期内不会复用的 `requestId`； | 将含混的“危险复用”改为已定义的“不复用”约束（第 167 行）。 |
| 匹配 Response、send failure 或 Response timeout 中最先完成者终结该 entry。 | 匹配到 Response、发生 send failure 或发生 Response timeout 时，最先发生的事件终结该 entry。 | 为三个并列事件补全谓语，并明确比较的是事件发生顺序（第 172 行）。 |
| 未完成的当前 `transport.send` 若被 Transport reject，则对应 Pending Request立即失败。 | 当前未完成的 `transport.send` 若被 Transport reject，则对应的 Pending Request 立即失败。 | 调整修饰语位置，补全结构助词并修复缺失空格（第 192 行）。 |
| 配置必须是有限正数；当前 PRD 的公共范围假设为 1 秒至 120 秒，由 Architecture 在 Story 拆分前复核并冻结构造时校验。 | 配置必须是有限正数。当前 PRD 假定公共配置范围为 1 秒至 120 秒；Architecture 在拆分 Story 前复核并冻结该范围，构造时对配置进行校验。 | 消除“冻结构造时校验”的错误修饰关系，并分别明确复核、冻结和校验的对象（第 195 行）。 |
| 仍在处理或仍处于去重保留期的重复入站 `requestId` | 入站 `requestId` 与仍在处理或仍处于去重保留期的请求重复 | 明确“仍在处理”和“处于保留期”修饰请求，而不是修饰 `requestId`（第 204 行）。 |
| 不再次执行 handler，返回 `request.duplicate`；默认 tombstone 最多 1024 条且保留 10 分钟，以先到者淘汰 | 不再次执行 handler，返回 `request.duplicate`；tombstone 默认最多保留 1024 条，保留期为 10 分钟；达到数量上限时淘汰最早的记录 | 明确数量上限、时间上限和淘汰触发条件之间的关系（第 204 行）。 |
| 阻止已经开始的旧异步 handler Response 写入已销毁 Session； | 阻止已经启动的旧异步 handler 向已销毁的 Session 写入 Response； | 消除连续名词造成的修饰歧义，明确写入方向和写入内容（第 229 行）。 |
| `not-delivered` capacity failure<br>`not-delivered` not-connected failure | 结果为 `not-delivered`，原因为 capacity failure<br>结果为 `not-delivered`，原因为 not-connected failure | 明确 outcome 与 failure reason 的关系，避免将相邻英文术语误解析为一个未定义的复合值（第 278-279 行）。 |
| Operation 缓存迁移还必须删除或隔离当前同 revision synthetic 替换特例：权威缓存只接受严格更高 revision，本地 optimistic 投影不能写入带 revision 的权威缓存。 | Operation 缓存迁移还必须删除或隔离当前允许以相同 revision 进行 synthetic 替换的特例：权威缓存只接受严格更高的 revision，本地 optimistic 投影不能写入带 revision 的权威缓存。 | 补全连续中英文修饰语之间的关系，明确该特例允许的行为（第 420 行）。 |
| **每次连接由 SDK 调用 factory 创建新 Transport/Session。** 被调用者创建稳定 Transport 实例并注入 Client 取代。 | **每次连接由 SDK 调用 factory 创建新 Transport/Session。** 该方案已由“调用方创建稳定的 Transport 实例并将其注入 Client”取代。 | 补出旧方案与替代方案的边界和主语，避免将“被调用者”误解析为“callee”（第 435 行）。 |
