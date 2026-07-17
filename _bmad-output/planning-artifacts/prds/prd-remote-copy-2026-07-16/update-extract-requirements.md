# PRD Update Extract: Client / Session / Transport Requirements

## 1. 提取目的与裁决顺序

本文件为 `prd.md` 更新提供 WHAT 侧素材，不是新的架构文档。需求裁决按以下优先级进行：

1. 当前任务中最新确认的 Client、Session、Transport 职责；
2. `AGENTS.md` 中不可违反的仓库边界和验证要求；
3. 现有 brownfield 与 architecture source extracts；
4. 旧 addendum 与 memlog 中仍未被后续讨论推翻的内容。

以下旧结论已被最新讨论取代，不应直接回填 PRD：

- Session 创建、替换或主动重连 Transport；
- Session 复制 Transport 的 `connecting` / `disconnected` / `error` 状态；
- Transport 断开时 Session 立即清空全部 pending Request；
- 每个连接代际都必须创建新的 Transport 对象；
- Session 为尚未完成的并发业务请求建立第二套发送队列。

当前收敛原则是：Transport 独占连接与传输可靠性，Session 独占协议关联，Client 独占应用层语义与面向调用者的生命周期编排。

## 2. 产品目标

为 Browser SDK 与 Server 提供一组可独立复用的 Session 与 Transport 能力，使应用调用者能够通过统一 Client 提交远程输入和订阅通知，而无需理解协议报文、Socket.IO、分片、窗口、ACK、重传或重连。

本次交付需要实现以下结果：

- Browser 调用者只组合 SDK Client 与选定的 Client Transport；未来替换 Transport 时不改变远程输入 API。
- Server 不依赖应用 SDK，而是直接组合相同 Session 契约与 Server Transport。
- 多个并发 Request 可以同时在途，并且每个调用只由自己的 Response、传输失败、协议失败或响应超时完成。
- 大消息、并发消息和短暂链路异常由 Transport 内部处理，不泄漏分片与重试语义。
- 传输最终失败能够确定地返回给发起调用；已经失败的消息不会在未来连接恢复后被偷偷交付。
- Transport 连接状态对 Client/组合根可观察，但 Session 的协议逻辑不依赖该状态。

## 3. 目标用户与 JTBD

### U1 - Browser SDK 使用者

当网页需要向远端提交输入或查询状态时，开发者希望安装 SDK 与一种 Transport，创建 Transport 后注入 Client，并通过稳定的应用 API 完成连接、输入和通知订阅，而不直接创建 Session 或解析协议。

期望调用体验：

```ts
const transport = new SocketIoClientTransport(options);
const client = new RemoteInputClient({ transport });

await client.connect();
await client.inputText(text);
const unsubscribe = client.subscribe(listener);
```

代码仅作为目标使用体验，构造器和方法的最终 TypeScript 形状属于公共 API 设计。

### U2 - Server 集成者

当 Server 需要作为协议对端接收 Request、返回 Response 和主动发送 Notification 时，开发者希望直接组合 Session 与 Server Transport、注册类型化 handler，而不依赖 Browser SDK 或处理 Transport 帧。

### U3 - Transport 实现者

当开发者实现另一种链路适配时，希望只需满足完整字节消息、连接生命周期、可靠交付与错误语义，不必理解 `input.submit`、`operationId` 或其他业务协议内容。

当前版本只交付 Socket.IO 实现；WebSocket 与 Bluetooth 仅用于验证契约可替换性，不进入实现范围。

## 4. 能力分组

### CAP-1 - SDK Client 组合与应用 API

- 对外提供轻量 Client，承载 `inputText`、操作查询/缓存和通知订阅等应用语义。
- Client 接受调用者创建好的 Transport；SDK 不硬编码 Socket.IO，也不要求 Browser 直接创建 Session。
- Client 通过 Session 完成所有协议消息交互，不能绕过 Session 构造或解析协议报文。
- Client 可使用 Transport 的生命周期观察面向调用者发布连接/就绪信息，并在新连接需要时恢复应用层会话。
- 同一个 Client 在显式断开后仍可再次连接，无需调用者重建 Client。

### CAP-2 - 通用 Session 协议关联

- Session 接受类型化 `method + body`，组装含唯一 `requestId` 的 Request，并维护 pending Request 关联。
- Session 支持并发 Request、Response、Notification、入站 Request handler，以及独立身份的 Ping/Pong。
- Session 对每个 Request 单独执行响应超时；Transport delivery timeout 与 Session response timeout 是不同失败来源。
- Session 不理解 `inputText`、Socket.IO、连接重试、分片、窗口或 ACK。
- Session 面向 Transport 的数据能力仅为发送一条完整字节消息，以及注册完整字节消息接收函数。
- 多个上层 Request 均立即尝试提交给 Transport；Session 不因为较早 Request 尚未结束而扣住后续 Request。

### CAP-3 - 完整消息 Transport

- Transport 对 Session 提供可靠、有序、保留消息边界的双工完整字节消息通道。
- 每次 `send` 代表一条完整消息；每个调用具有独立完成结果。
- Transport 统一拥有排队、顺序、背压和并发发送调度；Session 不维护平行发送队列。
- Transport 可以在内部拆分、窗口化和重组消息，但 Session 只看见完整消息。
- Transport delivery 成功只表示对端 Transport 已确认完整消息，不代表对端 Session 已返回 Response，也不代表远端业务操作完成。

### CAP-4 - Transport 连接恢复与失败确定性

- Transport 独占底层连接、连接恢复、同一次交付中的重发以及传输资源清理。
- Session 不查询 Transport 状态、不调用重连、不因断线事件提前终止 Request；已交付而未收到 Response 的 Request 由 Session 响应超时结束。
- Transport 在其交付策略耗尽后拒绝对应 `send`；Session 将该失败关联回发起 Request，Client 将其暴露为 Transport/交付错误。
- 一旦某个 `send` 被 Transport 判定失败，Transport 必须永久放弃该次消息，不能在后续恢复后再次交付。
- Transport 恢复连接可以服务后续新消息，但不得复活已经失败的发送。
- 主动 Client Transport 与被动 Server accepted Transport 可以有不同的连接建立机制，但必须遵守同一发送、接收和失败语义。

### CAP-5 - 生命周期观察与职责隔离

- Transport 连接状态是唯一事实源，可由 Client 或 Server 组合根读取和订阅。
- Session 不拥有或公开 Transport 的 `disconnected` 状态，也不把 Transport 状态检查作为发送前置条件。
- Client 使用生命周期状态的目的限于应用层连接编排、就绪表达、显式 connect/disconnect 和 UI 通知；协议消息仍必须经过 Session。
- 状态快照与状态事件不得改变 `send` Promise 的权威性：状态检查通过不保证随后发送成功。

### CAP-6 - Socket.IO 标准实现与端到端互操作

- 当前交付提供可互操作的 Socket.IO Client/Server Transport。
- 该实现能够在有限丢包、重复帧、ACK 丢失、大消息和双向并发下保持完整消息边界、顺序和至多一次向上交付。
- 不可恢复的链路失败、非法传输数据或资源耗尽必须有确定结果并释放相关资源。
- Socket.IO Transport 不解析业务 JSON，也不能把 Socket.IO 默认 delivery、离线缓冲或 event ACK 直接冒充本产品的可靠交付语义。

### CAP-7 - 发布、导出与 brownfield 迁移

- SDK、Session 能力和具体 Transport 实现是独立消费/发布边界。
- Browser 直接安装 SDK 与选定的 Client Transport；Session 作为 SDK 内部使用的协议能力，不要求 Browser 直接组合。
- Server 直接组合 Session 与选定的 Server Transport，不依赖 SDK。
- `packages/protocol` 继续作为统一应用协议的唯一事实源；definitions 与 implementations 的导出边界保持清晰。
- Transport 接收 API 的迁移必须在 definitions、实现、SDK、Server、测试替身、exports 与中文文档中原子完成，不能长期保留动态探测的双接口。

## 5. 全局稳定 FR Seeds

以下编号可直接作为 PRD 全局 FR 起点；后续只增补，不因分组重排而重新编号。

### Client 与组合

- **FR-001**：Browser 调用者必须能够将一个已配置的 Client Transport 实例注入 SDK Client，而无需让 SDK 依赖具体 Transport 技术。
- **FR-002**：SDK Client 必须向调用者提供远程文本输入能力，并将该调用映射为 Session Request，而不是直接构造或发送 Transport 数据。
- **FR-003**：SDK Client 必须向调用者提供通知订阅能力，并将 Session Notification 转换为应用层事件或状态更新。
- **FR-004**：SDK Client 必须支持显式建立和关闭其使用的连接，并允许同一个 Client 在显式关闭后再次建立连接。
- **FR-005**：SDK Client 必须能够观察 Transport 生命周期，用于发布应用连接/就绪状态和完成当前连接所需的应用层会话初始化。
- **FR-006**：Browser 使用 SDK 时不得被要求直接创建、调用或理解 ProtocolSession。
- **FR-007**：Server 必须能够在不依赖 SDK Client 的情况下直接组合 Session 与 Server Transport。

### Session

- **FR-008**：Session 必须接受类型化的 method 与 body，并为每次 Request 生成在其相关生命周期内唯一的 `requestId`。
- **FR-009**：Session 必须在发送 Request 前登记 pending 关联，使早到 Response 仍能关联到正确调用。
- **FR-010**：Session 必须允许多个 Request 并发在途，并仅使用匹配的 `requestId` 完成对应调用。
- **FR-011**：Session 收到新的上层 Request 时必须立即尝试把其完整报文提交给 Transport，不得等待其他 Request 的 Response 或 Transport send 完成。
- **FR-012**：Session 必须为每个 pending Request 应用独立的 Response deadline；未在期限内收到匹配 Response 时，该 Request 以响应超时失败并释放关联资源。
- **FR-013**：Transport delivery 所耗时间不得被误算为对端 Session 的响应处理时间；Response deadline 的明确起点必须与 Transport 交付完成语义一致。
- **FR-014**：对应的 Transport `send` 失败时，Session 必须只完成仍处于 pending 的关联 Request，并向上暴露传输交付失败。
- **FR-015**：匹配 Response 已先完成 Request 时，随后到达的本地 `send` 结果不得反转该已完成结果。
- **FR-016**：未知、重复或迟到 Response 不得匹配到另一个 Request，也不得复活已结束调用。
- **FR-017**：Session 必须支持类型化成功 Response、结构化失败 Response、单向 Notification 和入站 Request handler。
- **FR-018**：Session 必须支持使用独立 `heartbeatId` 的 Ping/Pong，且该标识不得占用或混用 Request 关联空间。
- **FR-019**：Session 必须在将解码后的成功结果、Request body 或 Notification body暴露给调用者之前执行相应的运行时校验。
- **FR-020**：Session 面向 Transport 时只能依赖完整消息 `send` 与完整消息 `receive`，不得依赖具体 Transport 类型、帧、窗口、ACK 或重连 API。
- **FR-021**：Session 不得读取、缓存或发布 Transport 连接状态，也不得通过状态预检查决定是否提交消息。

### Transport

- **FR-022**：Transport 必须接受一条完整 `Uint8Array` 消息，并为该消息返回独立的异步交付结果。
- **FR-023**：Transport 必须通过接收注册向 Session 交付完整 `Uint8Array` 消息，不得暴露部分消息或底层传输帧。
- **FR-024**：Transport 必须在双向通信中保持完整消息边界及发送提交顺序，并对每条完整消息至多向上交付一次。
- **FR-025**：Transport 必须接受多个尚未完成的并发 `send`，并在内部统一处理排队、背压和传输调度。
- **FR-026**：Transport `send` 只能在对端 Transport 已确认整条消息后成功；该成功不得被解释为协议 Response 或业务操作完成。
- **FR-027**：Transport 必须自行处理建立底层连接、意外断线后的恢复以及同一次交付预算内的重发，不得要求 Session 编排这些行为。
- **FR-028**：Transport 在无法于有限交付策略内完成消息时必须拒绝该 `send`，并提供可识别的传输失败原因。
- **FR-029**：Transport 一旦拒绝某个 `send`，必须保证该消息不会在任何后续连接或内部任务中被再次交付。
- **FR-030**：Transport 必须允许恢复后的连接承载后续新消息，而不恢复已经失败的发送。
- **FR-031**：当单个消息违反大小限制或新提交触发队列容量限制时，Transport 必须可预测地拒绝受影响调用，而不得伪造成功。
- **FR-032**：当链路可靠性已无法保证时，Transport 必须结束所有受影响的未完成发送并清理其发送、接收与计时资源。
- **FR-033**：Transport 必须提供可供 Client/组合根同步读取的生命周期快照和后续变化订阅；Session 不消费该生命周期面。
- **FR-034**：显式关闭必须停止当前连接及其自动恢复；调用者后续显式建立连接时，同一 Client/可复用 Transport 必须能够再次工作。

### Socket.IO 与互操作

- **FR-035**：当前版本必须提供满足 MessageTransport 契约的 Socket.IO Client Transport 和 Socket.IO Server Transport。
- **FR-036**：Socket.IO Client/Server Transport 必须在消息大于一次底层载荷时透明地分割、传输并重组为同一条完整消息。
- **FR-037**：Socket.IO Client/Server Transport 必须在可恢复的数据丢失、ACK 丢失和重复传输下保持顺序、边界及至多一次向上交付。
- **FR-038**：Socket.IO Client/Server Transport 必须支持跨多条排队消息有效利用传输容量，同时维持每条 `send` 的独立完成语义。
- **FR-039**：Socket.IO Client/Server Transport 必须拒绝非法或自相矛盾的链路数据，并保证该失败不会把部分消息暴露给 Session。
- **FR-040**：Socket.IO Client Transport 的连接恢复不得依赖 Socket.IO 默认离线缓冲来偷偷发送已失败的产品消息。
- **FR-041**：Socket.IO Server Transport 必须能够包装 Server 已接受的 Socket；该被动端无法主动恢复原 Socket 时，Server 组合根必须能够接受新连接并建立新的对端组合。

### 契约、错误与迁移

- **FR-042**：Transport、Session 和 SDK 必须分别暴露链路交付失败、协议响应超时、远端协议失败和业务操作状态，不得把这些完成语义合并。
- **FR-043**：`requestId`、`heartbeatId`、`operationId` 和 Transport 内部传输标识必须保持独立职责，不得跨层复用。
- **FR-044**：Codec 必须把入站字节视为不可信输入并完成协议 envelope 与适用 body 的运行时校验；禁止未经校验的类型断言绕过边界。
- **FR-045**：协议根入口与 definitions 必须只导出类型、常量和分层契约；标准 Codec、Session 与 Transport 运行时实现必须从 implementations 显式导入。
- **FR-046**：公共契约变更必须在 definitions、implementations、SDK、Server、测试替身、package exports 与中文文档中同步交付。
- **FR-047**：Transport 上行数据契约必须收敛为单一 receive 入口；迁移后不得由 Session 动态探测旧、新两种接收接口。
- **FR-048**：所有面向调用者的失败都必须保持原始 cause 或等价诊断信息，使 Client 能区分 Transport 问题、Response timeout 与远端协议错误。

## 6. NFR 与资源边界

### NFR-1 - 有界资源

- 单条完整 Transport 消息默认上限为 **256 KiB**。
- Transport 发送队列默认最多 **128 条消息**，且总计不超过 **4 MiB**。
- Session pending Request 必须有明确硬上限；当前兼容基线为 **128 条**。
- Transport 的连接尝试、交付尝试、无进展重组和内部缓存都必须有有限预算；任何失败路径不得遗留队列、窗口、重组缓存或计时器。
- 精确 chunk、窗口、ACK deadline、重发轮次和重组 deadline 是当前 Socket.IO 实现参数，应保留在 addendum/architecture，并由测试锁定，而不是写成通用 Session 产品能力。

### NFR-2 - 正确性与确定性

- 并发 Request 不得串配 Response。
- 完整消息不得出现重复上行交付、乱序交付、边界合并或部分交付。
- 每个 Request 与每个 Transport `send` 都只能完成一次。
- Transport reject 后不允许未来迟到交付，是不可放宽的确定性保证。
- Transport 状态快照仅供观察，发送结果以 `send` resolve/reject 为唯一权威。

### NFR-3 - 互操作与兼容

- 当前 Socket.IO Client 与 Server 必须使用兼容的 Transport 配置和 wire version；本版本不要求线上协商。
- 已发布的 SDK 状态、核心错误含义和 operation 公共状态应保持兼容，任何 breaking change 必须明确记录。
- `subscribe -> receive` 若进入正式范围，视为一次 workspace 级 breaking migration，不能长期双轨。
- 标准实现和自定义测试 Transport 必须通过同一 definitions 契约编译。

### NFR-4 - 可验证性

- Protocol tests 必须覆盖 Request/Response 成功与失败、并发关联、Response timeout、Notification、Ping/Pong、非法报文与运行时结果校验。
- Transport tests 必须覆盖完整 wire 互操作、拆分/重组、双向顺序、跨消息并发、累计确认、丢失/重复、有限重发、send 完成时机、资源边界、重连、reject 后不再交付以及非法链路数据清理。
- SDK tests 必须覆盖实例注入、Client connect/disconnect/reconnect、`inputText` 的错误映射、通知订阅和 Transport 状态到 Client 状态的映射。
- Server tests 必须覆盖 accepted Socket 组合、Session handler、Notification 和新连接建立新的对端组合。
- 跨 workspace 交付必须通过 `pnpm test:protocol`、`pnpm test:sdk`、`pnpm test:server`、`pnpm check` 和 `pnpm build`。
- 真实联调只验证 `session.open`，不得自动发送非空 `input.submit`。

### NFR-5 - 分层与可替换性

- Session/Transport 的公共契约不得依赖 DOM、React、Node HTTP、剪贴板或具体输入执行逻辑。
- Socket.IO 实现不得解析业务 JSON；Client UI 不得解析协议报文。
- 新 Transport 实现必须可在不修改 Session Request/Response 逻辑和 SDK 远程输入 API 的情况下接入。

## 7. 成功标准与反指标

### 成功标准

1. Browser 示例只需创建 Socket.IO Transport、注入 Client、连接后调用 `inputText`/订阅通知；不直接接触 Session 或协议报文。
2. Server 能够只使用 Session 与 Socket.IO Server Transport 完成相同协议的 handler 与 Notification 交互，不依赖 SDK。
3. 多个并发 Request 在 Response 逆序返回时仍准确完成各自调用，且后发 Request 不被 Session 扣住。
4. 大消息与多消息并发在受控丢 DATA、丢 ACK 和重复传输场景下保持完整、顺序和至多一次交付。
5. Transport 在恢复预算内可以继续交付；预算耗尽时相应 Client 调用得到确定错误，失败消息之后永不出现。
6. 已交付但未响应的 Request 由 Session Response deadline 确定失败并释放 pending 资源，即使 Session 从未感知 Transport 断线。
7. Client/组合根可以观察 Transport 生命周期；Session 测试替身只需数据面即可证明 Session 不依赖状态与重连。
8. 全部跨 workspace 验证命令通过，公共导出和中文 README 与新契约一致。

### 反指标

- 不以 Transport ACK 作为 `inputText`、协议 Request 或长期 operation 的业务成功。
- 不通过 Session 排队来掩盖 Transport 背压或连接失败。
- 不因“自动重连”使调用者已经收到失败的消息随后又被送达。
- 不为了支持 Socket.IO 而让 Session 或 SDK 暴露 frame/chunk/window 概念。
- 不以保留旧、新双接收 API 的方式换取表面 source compatibility。

## 8. 非目标

1. 本版本不实现或模拟 Bluetooth/GATT/MTU Transport。
2. 本版本不实现新的 WebSocket Transport 或通用不可靠链路协议。
3. 不建立同时承担协议关联和链路传输职责的 Channel 抽象。
4. 不让 Session 承担连接状态机、重连策略、Transport 发送排队或业务 operation 缓存。
5. 不提供公共 `sendBatch()`；跨消息窗口化仅是具体 Transport 内部优化。
6. 不保证跨已经失败的 `send` 自动重放，也不承诺 exactly-once 业务执行。
7. 不在 Session/Transport 中实现剪贴板、粘贴、输入队列、React UI 或操作历史。
8. 不新增认证、授权、TLS、端到端加密、数据库或新的部署拓扑。
9. 不在本 PRD 中规定 Bluetooth 设备选择体验或 Server 输入执行细节。
10. 不将 Socket.IO 默认重连、离线事件缓冲、event ACK 或 connection state recovery 直接当作本产品的可靠交付保证。

## 9. 兼容面

### 公共 SDK 面

- `RemoteInputClient`/Client 构造与 Transport 实例注入。
- `connect()`、`disconnect()`、`inputText()`、操作查询、通知订阅以及公开 Client state。
- SDK 错误码、错误 cause 与 operation state/revision 语义。
- `packages/sdk/src/index.ts` 和 SDK 中文 README。

### Session 契约面

- `request`、`notify`、Request handler、Notification subscription、heartbeat 与 options。
- requestId 关联、Response deadline 起点、pending 上限、early/late Response 和 first-terminal-result 行为。
- Session 对 Transport 的窄数据依赖：complete-message `send` + `receive`。

### Transport 契约面

- 完整消息 `send`/`receive`、并发 send、顺序、边界、完成和 reject-finality。
- 供 Client/组合根使用的 `connect`/`disconnect`、state snapshot 与 lifecycle event 面。
- 主动 Client Transport 与被动 accepted Server Transport 的不同建链方式。
- 自定义 Transport 和测试替身的 TypeScript source compatibility。

### 包与导出面

- Browser 安装 SDK + 一个 Client Transport；Server 安装/组合 Session + Server Transport。
- 根/definitions 不泄漏运行时实现，implementations 不成为业务协议定义源。
- Session、Transport 与 SDK 的独立发布边界以及对应版本兼容声明。

### Wire 与部署面

- 当前 Socket.IO Client/Server wire 必须成对互操作。
- `protocol:frame`、binary frame layout、序号、ACK、窗口和默认 timer 的具体机制继续由 addendum/architecture 锁定。
- 不匹配的 framing 配置当前是部署错误；本版本不新增线上能力协商。

## 10. 必须留在 addendum / architecture 的技术 HOW

以下内容可作为验收测试实现依据，但不应占据 PRD 主体：

- Socket.IO 单一事件名、DATA/ACK 字节布局、magic/version/kind、字段 offset 和大端编码；
- 16 KiB chunk、8-frame window、2 秒 ACK deadline、最多 3 次重发、10 秒无进展重组 deadline 的具体默认值；
- Go-Back-N、累计 ACK、ACK 绕过窗口、frame/message 序号和重组算法；
- Transport 内部如何创建新 Socket、如何标记 connection generation、如何抑制旧 listener 与 Socket.IO offline buffer；
- Session pending `Map` 的 TypeScript shape、timer 存储和 first-wins 代码结构；
- `transport.state` 枚举和 `transport.on` 事件联合的最终 TypeScript 命名；
- Client 如何在 Transport 新连接后编排 `session.open` 的具体类/函数结构；
- package 目录树、class/file 名称、迁移提交顺序与私有 controller 拆分。

## 11. PRD 收敛前仍需显式裁决的项目

### 阶段阻塞项

1. **Session Response deadline 起点**：现有实现与架构是 `transport.send()` 成功后开始；最新讨论确认了 Session 有 Response timeout，但没有再次明确起点。建议 PRD 固定“Transport 完整交付成功后开始”，以保持 delivery time 与 response time 分离。
2. **Transport 自动恢复触发**：已确认恢复属于 Transport，但尚未区分“断线后立即后台恢复”与“下一次 `send` 时按需恢复”。PRD 可以只要求恢复职责和有限预算，把触发策略留给 Transport 配置；若 Client state/体验依赖具体行为，则必须固定。
3. **新 Socket 的应用会话初始化**：当前 Server 要求每个新连接先 `session.open`。Session 不感知重连后，应明确由 Client 观察 Transport lifecycle 并为新连接重新 open，或另行定义逻辑会话恢复；当前 brownfield 最小方案是 Client 重新 open。
4. **Session 接收契约形状**：最新原则是 Session 只接收完整字节消息，生命周期 state/error 走 Client/组合根的独立观察面。应明确 `receive(listener: (bytes) => void)` 与 `on(lifecycleListener)` 分离，而不是继续把 state/error 混在 Session 消费的 event union 中。

### 非阻塞但应记录

5. Transport lifecycle state 的最终枚举、fatal 后终态与 event ordering。
6. Transport 失败是只拒绝当前消息，还是在链路不可信时拒绝所有未完成消息；需求可按 call-local 与 connection-fatal 两类错误区分。
7. Session 对未知/迟到 Response 是静默忽略还是发布诊断事件；两者都不得影响其他 Request。
8. Session/Transport/SDK 独立发布是独立 npm package，还是一个 protocol package 的独立 subpath/API version；当前产品组合要求已明确，物理包切分仍属架构决策。

## 12. 推荐 PRD 主体结构

1. Executive Summary / Product Outcome
2. Users & Jobs to Be Done
3. Scope and Non-Goals
4. Capability Requirements
   - SDK Client Composition
   - Protocol Session
   - Complete-Message Transport
   - Socket.IO Pair
   - Packaging & Integration
5. Error and Completion Semantics
6. Resource, Reliability and Compatibility NFRs
7. Success Criteria
8. Open Decisions

具体 wire、算法、状态机和迁移机制统一引用 `addendum.md`，避免 PRD 退化为实现设计。
