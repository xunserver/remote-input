---
title: Client、Session 与 Socket.IO Transport 分层重构
status: final
created: '2026-07-16'
updated: '2026-07-17'
---

# PRD: Client、Session 与 Socket.IO Transport 分层重构

## 0. 文档目的

本文面向 SDK、协议、Transport、Server 和后续 Architecture/Story 实现者，定义 remote-copy 下一版 Client、Session 与 Transport 的能力边界、完成语义、失败语义和验收标准。正文只约束调用方可以依赖的行为；Socket.IO 帧格式、窗口、ACK、重传算法、接口草图和迁移细节保存在同目录的 `addendum.md`。

## 1. 产品愿景

remote-copy 要提供一条可组合、可替换的远程输入链路。Browser 开发者只需创建一个具体 Transport，将其注入 SDK Client，随后通过稳定的输入、查询和通知 API 使用远端能力；Server 开发者则直接组合相同的 Session 能力与 Server Transport，不依赖 Browser SDK。

本次重构的核心判断是：应用语义、协议关联和链路可靠性必须分别只有一个所有者。Client 拥有远程输入、应用就绪和面向调用者的状态；Session 拥有 Request/Response、Notification、运行时校验和 Response timeout；Transport 拥有连接、重连、排队、拆分、窗口、ACK、重传与完整消息交付结果。任何一层都不得复制相邻层的状态机或队列。

当前版本交付 Socket.IO Client/Server Transport。未来 WebSocket 或 Bluetooth Transport 可以遵守相同边界独立提供，但不进入本次实现范围。

## 2. 目标用户与工作任务

### 2.1 Browser SDK 开发者

- 创建并配置适合当前环境的 Client Transport。
- 将 Transport 注入 Client，而不直接创建 Session 或理解协议报文。
- 显式连接后提交文本、查询状态并订阅通知。
- 在连接恢复、交付失败或 Response timeout 时获得稳定、可诊断的结果。

### 2.2 Server 集成者

- 将 accepted Socket 包装为 Server Transport。
- 直接组合 Session、注册类型化 Request handler 并发送 Notification。
- 不依赖 SDK，不解析业务 JSON，也不处理 Transport frame。

### 2.3 Transport 实现者

- 只实现可靠、有序、保留消息边界的完整字节消息通道及其生命周期。
- 在实现内部处理底层连接、资源限制和可靠交付，而不理解 `input.submit`、`requestId` 或 `operationId`。

### 2.4 关键使用旅程

- **UJ-1. Lin 在 Browser 接入远程输入。** Lin 安装 SDK 与 Socket.IO Client Transport，创建并注入 Transport，等待 Client ready 后提交文本并订阅状态通知；整个过程不直接使用 Session、Codec 或 Socket.IO event。
- **UJ-2. Wei 在 Server 实现协议对端。** Wei 为每个 accepted Socket 组合 Server Transport 与 Session，注册 `session.open`、`input.submit` 和 `operation.get` handler，并通过 Session 推送 Notification。
- **UJ-3. Chen 验证并发和失败。** Chen 在第一个输入 Request 尚未完成时发出查询 Request；两个调用同时进入 Transport，按各自 `requestId` 独立完成。链路失败时，每个调用都得到确定的本地结果；失败消息不会被本地 Transport 在恢复后复活，但 `delivery-unknown` 明确提醒 Chen 对端可能已经收到。

## 3. 术语

- **Client**：SDK 对应用暴露的远程输入入口，当前实现类为 `RemoteInputClient`。
- **Session**：业务无关的协议关联层，负责 Request/Response、Notification、Ping/Pong、Codec 调用和 Response timeout。
- **Codec**：在经过校验的协议报文与 `Uint8Array` 之间转换的不可信输入边界。
- **Session Transport Port**：Session 可依赖的窄数据面，只包含完整消息 `send` 与完整消息 `receive`。
- **Managed Transport**：供 Client 或 Server 组合根使用的完整 Transport，除数据面外还提供连接、关闭、状态快照和生命周期观察。
- **Transport Message**：Transport 边界上的一条完整 `Uint8Array`；不是 chunk、frame、Request 或长期 Operation。
- **Request**：需要相同 `requestId` Response 才能完成的一次协议调用。
- **Pending Request**：Session 已登记且尚未由匹配 Response、Transport 失败或 Response timeout 完成的 Request。
- **Transport Delivery**：对端 Transport 确认收到一条完整 Transport Message；不表示对端 Session 已处理或业务已完成。
- **Delivery Failure**：Transport 在有限交付策略内无法完成一条消息，并终结对应 `send`。
- **Not Delivered**：Transport 能确定该消息没有任何 DATA frame 离开本地时的失败结果，可以安全判断为未交付。
- **Delivery Unknown**：至少一个 DATA frame 可能已经离开本地，但完整 Transport ACK 未到达时的失败结果；对端是否已完整接收或处理不可判定。
- **Response Timeout**：Transport Delivery 之后，Session 未在期限内收到匹配 Response。
- **Notification**：不使用 `requestId`、不等待 Response 的单向协议消息。
- **Connection Generation**：Transport 内部一次连续底层连接的生命周期；不进入 Session 数据面契约。
- **Operation**：由 `operationId` 关联的长期远程输入工作，不等同于一次 Request。

## 4. 功能需求

### 4.1 Client 组合与应用 API

#### FR-1：注入已创建的 Transport

Browser 调用者必须能够创建一个已配置但尚未由 Client 使用的 Client Transport，并把该实例注入 Client。

**可验证结果：**
- SDK Client 的运行时依赖不得默认导入 Socket.IO Transport。
- 更换 Transport 实现不得改变 Client 的远程输入和通知 API。
- Browser 不需要直接创建 Session。

#### FR-2：提供稳定的应用入口

Client 必须提供显式连接、显式关闭、远程文本输入、操作查询和通知订阅能力。

**可验证结果：**
- `inputText` 调用被映射为类型化的 `input.submit` Session Request。
- 通知订阅只交付经过 Session/Codec 校验的 Notification 或该 Notification 的应用投影。
- Client 不直接构造协议 envelope，也不直接调用 Transport `send` 发送业务报文。

#### FR-3：支持 Browser 与 Server 的不同消费路径

Browser 必须只直接消费 SDK 与选定的 Client Transport；Server 必须能够只消费 Session 与选定的 Server Transport。

**可验证结果：**
- Server 代码不依赖 SDK package。
- Browser 业务代码不直接依赖 Session implementation。
- 两端共享同一协议 definitions、Codec 规则和 Session 契约。

#### FR-4：Client 观察生命周期但不拥有传输实现

Client 必须能够读取 Managed Transport 的生命周期状态并订阅其变化，用于连接编排、应用就绪和 UI 状态；协议数据仍只能经过 Session。

**可验证结果：**
- Transport 状态快照或事件不得被当作某次 `send` 成功的证明。
- Client 不包含 Socket.IO、WebSocket 或 Bluetooth 专属分支。
- UI 通过 Client 状态使用连接信息，不解析协议报文。

#### FR-5：应用就绪与 Transport connected 分离

Client 只能在 Transport 能交换完整消息，且当前 Connection Generation 的 `session.open` 成功后进入应用 ready 状态。

**可验证结果：**
- Transport connected 但 `session.open` 尚未成功时，Client 不报告 ready。
- `client.connect()` 只能在当前 Connection Generation 的 `session.open` 成功、Client 已进入 ready 后 resolve，从而保证 `await client.connect(); await client.inputText(...)` 可直接工作。
- `session.open` 返回 ProtocolError、校验失败或超过 Client connect 总期限时，Client 停止 heartbeat、清除 ready、关闭当前 Connection Generation、进入可观察 error，并 reject 本次 `connect()`；同一个 Client 之后仍可再次显式 `connect()`。
- Client `connect()` 的默认总期限为 30 秒；Transport 初次建链的默认期限为 10 秒。超过任一期限时，都必须终结本次 `connect()`，不得使其永久 pending。
- Client 必须为每个新的 Socket.IO Connection Generation 恰好重新执行一次 `session.open`；open 完成前业务 API 以 `not-ready` 失败，不由 Session 建立业务队列。
- 旧连接迟到的 open 结果不得把新连接错误标记为 ready。
- Client 必须在 Transport 离开 connected 时立即清除 ready 并停止当前 heartbeat；只有新 Connection Generation 的 `session.open` 成功后才能重新启动 heartbeat。

#### FR-6：显式关闭后可再次连接

同一个 Client 与可复用 Client Transport 必须支持显式关闭后再次连接。

**可验证结果：**
- Client 保留无 URL 参数的 `connect()` 与 `disconnect()`；URL、设备或其他连接信息已封装在注入的 Transport 中。
- 显式关闭停止自动恢复，直到后续再次显式连接。
- 关闭、连接和重连并发时，旧关闭、连接或重连操作的迟到结果不得覆盖当前 Client 状态。

### 4.2 通用 Session

#### FR-7：类型化 Request/Response

Session 必须接受类型化 `method + body`，生成 Request，并以类型化结果或结构化失败完成调用。

**可验证结果：**
- 每个 Request 使用非空且在同一 Session 生命周期内不复用的 `requestId`。
- 成功 Response body 按原始 method 运行时校验后才交付调用者。
- 远端失败保留协议错误码、消息和可重试语义。

#### FR-8：发送前登记 Pending Request

Session 必须在调用 Transport `send` 前登记 Pending Request。

**可验证结果：**
- Response 即使早于本地 `send` Promise 完成，也能匹配正确调用。
- Pending Request 至少记录 method、完成函数和 Response timer 所需信息。
- `requestId` 只关联一次 Request/Response，不与其他标识混用。

#### FR-9：并发 Request 不由 Session 串行化

较早 Request 尚未收到 Response，或其 Transport `send` 尚未完成时，Session 必须立即尝试把后续 Request 提交给 Transport。

**可验证结果：**
- Request A 与 B 分别登记独立 Pending Request，并分别调用 Transport `send`。
- Response 可以逆序返回，并只完成匹配 `requestId` 的调用。
- Session 不实现第二套消息发送队列或 Transport 背压策略。

#### FR-10：独立 Response Timeout

每个 Pending Request 必须有独立 Response deadline；期限内没有匹配 Response 时，只失败并释放该 Request。

**可验证结果：**
- Response deadline 以对应 Transport `send` 成功的时刻为起点计算，即从对端 Transport 确认收到完整消息后计算；排队、连接恢复和链路重传时间由 Transport 自己限制。
- 默认 Response timeout 为 10 秒；配置值必须是有限正数。`[ASSUMPTION: 公共配置范围为 1 秒至 120 秒，超出范围在构造时失败。]`
- Response timeout 不改变其他 Request、Transport 连接或 Operation 状态。
- 超时后的迟到 Response 不得复活调用或匹配其他 Request。
- 如果匹配 Response 在本地 `send` Promise 完成前已经终结 Pending Request，随后到达的 send resolve/reject 和 timer callback 都是 no-op，且不得再启动 Response timer。

#### FR-11：Transport 失败只完成关联 Request

对应 Transport `send` 失败时，Session 必须将失败关联到仍处于 pending 的 Request，并在向 Client 暴露的失败中保留 Transport 的原始 cause。

**可验证结果：**
- 单条 call-local Delivery Failure 不错误完成其他 Pending Request。
- 若匹配 Response 已先完成调用，随后到达的本地 `send` failure 不得反转结果。
- Session 不对失败 Request 执行隐式协议重试。

#### FR-12：处理全部协议消息类型

Session 必须支持 Request、成功/失败 Response、Notification、Ping 和 Pong，并支持类型化入站 Request handler。

**可验证结果：**
- Notification 不创建 `requestId`。
- Ping/Pong 使用独立 `heartbeatId`。
- Session 同一时刻最多等待一个 Pong；默认 heartbeat interval 为 15 秒，Pong timeout 为 10 秒，二者均可配置为有限正数。
- Heartbeat 只在组合根显式启动后运行；Client 只能在当前 Connection Generation 的 `session.open` 成功后启动，并在 Transport 离开 connected 时停止。
- Pong timeout 只在对应 Ping 的 Transport `send` 成功且当前 heartbeat 运行周期仍有效后启动。
- `stopHeartbeat()` 必须使该 heartbeat 运行周期的所有 send callback、timer 和迟到 Pong 失效；旧 heartbeat 运行周期不得停止新的运行周期、清除新 Connection Generation 的 ready 状态或再次触发恢复。
- Heartbeat timeout 只停止 Session heartbeat 并发布结构化错误，不得由 Session 调用 Transport lifecycle API。Client 组合根收到错误后清除 ready，并串行执行当前 Client Transport 的 `disconnect()` 后 `connect()` 以强制创建新的 Connection Generation；Server 组合根关闭当前 accepted Transport。
- 未注册 method、handler 异常、重复 Request、未知/重复/迟到 Response、非法 Pong 与非法协议报文必须遵守下表，不得串配其他调用或重复执行 handler。

| 输入或失败 | Session 行为 | 是否继续工作 |
| --- | --- | --- |
| 未注册的 Request method | 使用相同 `requestId` 返回 `method.unsupported` | 是 |
| Handler 抛出 `ProtocolRequestError` | 原样映射其结构化 ProtocolError | 是 |
| Handler 抛出其他错误 | 使用相同 `requestId` 返回非重试的 `request.failed` | 是 |
| 收到与正在处理或仍处于有界去重保留期的 Request 使用相同 `requestId` 的新 Request | 不再次执行 handler，返回 `request.duplicate` | 是 |
| 未知、重复或迟到 Response | 只发布诊断错误，不匹配任何 Pending Request | 是 |
| 未知或迟到 Pong | 只发布诊断错误，不完成当前 heartbeat | 是 |
| Codec 校验失败 | 不调用 handler、不构造不安全 Response，只发布验证错误 | 是，除非底层同时报告 connection-fatal 非法 frame |

#### FR-13：Codec 是强制校验边界

Session 必须通过 Codec 编码出站报文并校验入站字节，禁止未经校验的类型断言绕过协议边界。

**可验证结果：**
- Request、Notification、ProtocolError 和成功结果按适用 schema 校验。
- 非法 UTF-8、JSON、版本、envelope 或 body 不进入业务 handler。
- Transport 不解析业务 JSON。

#### FR-14：Session 只依赖数据面并可释放自身资源

Session 面向 Transport 时只能依赖完整消息 `send` 与 `receive`，不得读取状态或调用连接 API；Session 必须拥有与 Transport disconnect 不等价的自身资源释放能力。

**可验证结果：**
- Session 测试替身无需实现 `state`、`connect`、`disconnect` 或 lifecycle events。
- 同一个 Session 必须独占一个 Transport data receive stream；不得让两个 Session 同时消费同一完整消息流。
- Session 注册的 receive listener 绑定稳定的 Transport 实例，在 Transport 内部重连和 Connection Generation 切换时保持有效，直到显式 unsubscribe 或 Session dispose。
- 入站重复 Request tombstone 默认最多保留 1024 条且最长 10 分钟，以先达到的限制为准；它不替代发送方在同一 Session 生命周期不复用 `requestId` 的契约。
- Transport disconnect 不会触发 Session 立即批量清空已完成 Transport Delivery 的 Pending Request；这些 Request 等待各自的 Response timeout。
- Session 必须提供幂等资源释放能力，用于取消 receive、停止 timer、拒绝剩余 Pending Request 并阻止旧 handler 回写；最终方法名由 Architecture 固定。
- Pending Request 默认硬上限为 128，超限只拒绝新 Request。

### 4.3 完整消息 Transport

#### FR-15：完整消息数据面

Transport 必须接受一条完整 `Uint8Array` 并向 Session 交付一条完整 `Uint8Array`，不得暴露部分消息或底层 frame。

**可验证结果：**
- 每次 `send` 对应一条 Transport Message 和一个独立 Promise。
- `receive` 只调用完整消息 listener。
- 交付给 receive listener 的 `Uint8Array` 必须是稳定快照或具有等价独占所有权，不得在 callback 返回后被 Transport 修改。
- 空消息与最大允许消息都具有确定行为。

#### FR-16：可靠、有序并保留边界

Transport 必须在单个有效连接上提供双向可靠、有序、保留消息边界且至多一次向上交付的消息通道。

**可验证结果：**
- 不出现部分交付、消息合并、重复上行交付或提交顺序倒置。
- 恢复性重发和重复底层数据不得造成重复完整消息。
- ACK 或重试细节不进入 Session。

#### FR-17：统一并发队列与背压

Transport 必须接受多个未完成的并发 `send`，统一管理排队、背压、顺序和传输调度。

**可验证结果：**
- Transport 可以让多条排队消息共同有效利用可用传输容量，但保持消息边界与顺序。
- 每个 `send` 独立完成或失败，不提供公共 `sendBatch`。
- 队列达到限制时，新调用得到可识别的容量错误。

#### FR-18：Transport Delivery 完成语义

Transport `send` 只能在对端 Transport 确认收到整条 Transport Message 后成功。

**可验证结果：**
- `send` 成功不等于协议 Response、`inputText` 的长期 Operation 完成或 Agent 已执行。
- Session Response timeout 不与 Transport 的 ACK/retry deadline 混用。
- 调用者可以区分 Delivery Failure 与 Response timeout。

#### FR-19：Transport 独占连接恢复

主动端 Transport 必须自行处理底层连接、意外断线恢复和当前有效连接内的 Delivery 重发，不得要求 Session 读取状态或调用 reconnect。

**可验证结果：**
- 同一时刻只能有一个有效的连接或重连尝试。
- 连接和交付尝试都有有限预算，不会使 `send` 永久 pending；Socket.IO 初次连接默认 deadline 为 10 秒。
- 主动 Client Transport 在首次显式 connect 成功后，遇到意外断线或 connection-fatal 失败必须自动进入 `reconnecting`；默认最多尝试 3 次且总恢复期限为 30 秒。
- `connecting` 或 `reconnecting` 期间的新 `send` 不进入队列，立即以 `not-delivered` 失败；Transport 只在存在处于 connected 状态的 Connection Generation 时接收新消息。
- 恢复成功时创建新的 Connection Generation 并进入 connected；恢复预算耗尽时进入 `error` 并停止自动恢复，直到后续显式 `connect()` 启动新的连接周期。
- 显式 disconnect 取消当前连接、重连和相关 timer，并在后续显式 connect 前禁止自动恢复。
- Client 在 application not-ready 期间拒绝业务 API，因此不会在新的 `session.open` 之前把业务 Request 排入恢复后的连接。
- 同一个未完成 `send` 不得跨新底层连接继续交付；具体 Transport 不得自行实现跨连接重放。

#### FR-20：Managed Transport 生命周期面

Client Managed Transport 必须向 Client 提供显式连接、显式关闭、同步状态快照和生命周期变化订阅；Server accepted Transport 必须提供当前 accepted connection 的状态、关闭与生命周期观察，但不要求主动 `connect()`。Session 不消费任一生命周期能力面。

**可验证结果：**
- 状态先更新，再发布对应事件。
- 每个新的 Connection Generation 进入 connected 时，快照和事件都必须携带单调递增且在该 Transport 实例内不复用的 `generation`；Client 以它作为每代只执行一次 `session.open` 的依据。
- 生命周期订阅必须提供无丢失的初始快照语义，避免读取 state 与注册 listener 之间漏掉 Connection Generation 切换；具体 API 形式由 Architecture 固定。
- 订阅返回幂等取消函数，listener 异常不打断 Transport。
- 状态检查显示 Transport 已 connected，也不保证随后 `send` 成功；`send` Promise 始终是权威结果。

#### FR-21：失败结果具有本地最终性

Transport 一旦拒绝某个 `send`，必须永久终结该本地调用并停止该消息的后续本地传输；失败不得被解释为对端一定没有收到或处理。

**可验证结果：**
- 连接恢复、timer、旧 callback 或内部队列不得在 reject 后发送该消息的任何新 frame。
- 在任何 DATA frame 离开本地前拒绝时返回 `not-delivered`；一旦可能发出过 DATA 但最终 ACK 缺失，则保守返回 `delivery-unknown`。
- `delivery-unknown` 不得被 SDK 标记为可安全自动重试；业务重试必须复用或查询相同 `operationId`，避免重复执行。
- Transport 可以恢复连接以服务后续新 `send`，但不能复活已失败调用。

#### FR-22：区分 Call-local 与 Connection-fatal 失败

Transport 必须区分只影响当前调用的资源拒绝，以及导致当前连接无法继续保证可靠交付的失败。

**可验证结果：**
- 单消息过大或新提交触发队列上限时，只拒绝受影响的新调用。
- 非法 frame、重组无进展、重传预算耗尽或序号耗尽时，清理并拒绝当前连接所有未完成 `send`。
- Connection-fatal 清理中，已经发出过 DATA 的调用返回 `delivery-unknown`；能证明尚未发出 DATA 的调用可以返回 `not-delivered`。
- 所有失败路径释放发送队列、窗口、重组缓存和 timer。

#### FR-23：Transport 资源有界

Transport 必须限制单消息、队列条数、队列总字节、连接尝试、交付尝试和重组存活时间。

**可验证结果：**
- 默认单条完整消息最多 256 KiB。
- 默认队列最多 128 条消息且总计不超过 4 MiB。
- 任何上限失败都返回结构化错误并保留原始 cause 或等价诊断信息。

### 4.4 Socket.IO 标准实现

#### FR-24：提供双端实现

当前版本必须提供满足相同完整消息和失败语义的 Socket.IO Client Transport 与 Socket.IO Server Transport。

**可验证结果：**
- Client 与 Server 实现可以双向并发互操作。
- 双端不解析业务协议 JSON。
- Server Transport 可以包装已 accepted 的 Socket。

#### FR-25：透明拆分与重组

Socket.IO Transport 必须在消息超过单次 frame 载荷时透明拆分，并且只在完整、合法重组后向上交付。

**可验证结果：**
- 大消息在多个 chunk 下保持原始字节和消息边界。
- DATA 发送窗口必须允许跨越消息边界，以统一调度连续提交的多条完整消息。
- 在可恢复范围内，数据或确认的丢失、重复和乱序不会造成部分或重复的完整消息交付。
- ACK 的具体窗口与确认机制由技术附录和互操作测试锁定。

#### FR-26：固定互操作通道

Socket.IO 双端必须通过单一二进制协议事件和相同 wire version 互操作；Transport ACK 不得使用或替代协议 Response。

**可验证结果：**
- DATA/ACK 布局、字节序和默认配置由技术附录及测试共同锁定。
- 配置不兼容时必须确定性失败，不得静默解释为另一种格式。
- Socket.IO 默认离线缓冲、event ACK 和 connection recovery 不被直接当作本产品 Delivery 保证。

#### FR-27：Connection Generation 隔离

每个新 Socket.IO 底层连接必须拥有隔离的可靠传输状态；旧连接事件不得污染当前连接。

**可验证结果：**
- 每个新连接的传输序号按技术附录从初始值开始。
- 当前版本不实现跨连接 resume；旧 Connection Generation 结束时，其所有未完成 `send` 必须终结：可证明没有发出 DATA 的返回 `not-delivered`，可能发出过 DATA 的返回 `delivery-unknown`。
- 新 Connection Generation 只服务旧 Connection Generation 结束后新提交的消息，不得重放、复活或继承旧 Connection Generation 的消息、窗口、ACK 与重组状态。
- 新 Connection Generation 进入 connected 时必须通过 FR-20 的生命周期面通知 Client，不能仅发布一个不含 `generation` 的 `connected` 状态。
- 旧 Socket 的迟到 DATA、ACK、disconnect 或 error 不改变当前连接状态或发送结果。

#### FR-28：主动端与被动端生命周期不对称

Client Transport 可以主动建立和恢复连接；Server accepted Transport 只管理当前 accepted Socket，断开后由 Server 组合根等待并组合新 Socket。

**可验证结果：**
- Server Transport 不尝试找回已经关闭的 accepted Socket。
- Server accepted Transport 在构造后即代表当前已接入 connection，不要求调用 `connect()` 才能接收完整消息。
- Client 重连产生的新 Socket 对应新的 Server Transport/Session 组合。
- 新 Server Session 在处理业务 method 前继续要求 `session.open`。

### 4.5 发布、迁移与兼容

#### FR-29：独立消费和发布边界

SDK、Session 能力和具体 Transport 实现必须能够独立安装、版本化和发布。

**可验证结果：**
- Browser 的依赖闭包包括 SDK、共享 definitions 和 Session 的必要依赖，以及一个显式选择的 Client Transport；SDK 不得隐式选择具体 Transport。
- Server 依赖 Session 与一个 Server Transport，不依赖 SDK。
- 最终 package 名称、root/subpath exports 与 peer dependency 范围由 Architecture 固定。

#### FR-30：协议唯一事实源与导出隔离

统一应用协议 definitions 必须保持唯一事实源，运行时 Codec、Session 与 Transport implementation 必须从明确的运行时入口导入。

**可验证结果：**
- definitions/root 不产生意外运行时依赖。
- 实现包不重新定义 ProtocolMessage、method 或 notification schema。
- 严格 TypeScript 与判别联合贯穿所有公开契约。

#### FR-31：保留应用层 Operation 语义

本次分层迁移不得改变公共 Operation state、revision 去重和 `operationId` 的长期职责。

**可验证结果：**
- 公共 state 仍只有 `accepted | processing | succeeded | failed`。
- Client 在发送 `input.submit` 前生成 `operationId`；`inputText` 允许调用者显式复用该 ID。ID 生成后发生 Transport 失败或 Response 失败时，对应失败对象必须携带该 ID，使调用者在收到 `delivery-unknown` 后可以先调用 `operation.get`，再决定是否使用相同 ID 重试。
- SDK 权威 Operation 缓存只接受 `incoming.revision > cached.revision`；本地 optimistic 投影不得作为带 revision 的权威记录写入缓存。
- `stage` 继续表示下游专属阶段，`succeeded` 不被解释为固定 Agent 已执行。
- Transport ACK 与 Request Response 均不冒充 Operation terminal state。

#### FR-32：原子迁移全部调用方

公共 API 变化必须在 definitions、实现、SDK、Server、Client、测试替身、exports 和中文文档中一次性收敛，不保留运行时双接口探测。

**可验证结果：**
- 仅实现 Session Transport Port 的 Session 测试替身也必须能够编译通过。
- SDK bundle/import graph 不默认加载具体 Socket.IO Transport。
- 当前包均为 private workspace package，本次采用原子 breaking migration：移除 `sendInput`、Transport factory、Session connect/state API 和旧 Transport 联合 `subscribe`，不保留 deprecated alias、运行时双接口探测或兼容 adapter。
- 目标 SDK 输入方法名采用 `inputText`；Notification 与 Client state 的最终订阅方法名由 Architecture 固定，不把口语拼写直接固化为 API。

## 5. 跨功能需求

### 5.1 正确性与可靠性

- 每个 Request 和每个 Transport `send` 最多完成一次。
- 并发 Response 不得串配，迟到结果不得反转已经完成的调用。
- Transport Message 不得部分交付、合并、乱序或重复向上交付。
- Transport reject 后不再产生该消息的新本地传输，是不可放宽的保证；对端接收结果的可判定程度由 `not-delivered | delivery-unknown` 明确表达。
- Session 不得通过读取 Transport state 决定某次发送是否成功。

### 5.2 资源与时限

- Session 默认最多保留 128 个 Pending Request；每个 Request 都必须有 Response deadline。
- Session 默认 Response timeout 10 秒、heartbeat interval 15 秒、Pong timeout 10 秒；所有可配置期限都必须是有限正数并在构造时校验。
- Transport 默认单消息上限 256 KiB，发送队列上限 128 条且总计不超过 4 MiB。
- Transport 的连接、ACK/retry、重组和队列等待必须有有限预算；默认机制记录在技术附录。
- 所有关闭、失败和 dispose 路径都不得遗留 listener、Promise、队列、重组缓存或 timer。

### 5.3 可替换性与依赖

- Session/Transport 公共契约不得依赖 React、DOM、Node HTTP、剪贴板或输入执行。
- 新 Transport 可以在不修改 Session Request/Response 逻辑和 Client 远程输入 API 的情况下接入。
- 当前只实现 Socket.IO；可替换性通过契约与测试替身证明，不通过虚构 Bluetooth 实现证明。

### 5.4 错误与可观测性

- Client 必须能区分连接建立失败、Transport `not-delivered`、Transport `delivery-unknown`、Session Response Timeout、Heartbeat Timeout、远端 ProtocolError、协议校验失败和长期 Operation failure；`inputText` 在生成 ID 后失败时必须同时暴露 `operationId`。
- 跨层错误保留原始 cause 或等价诊断信息，但 SDK 公共错误不得依赖 Socket.IO 专属 message string。
- Transport state/event 用于生命周期与诊断，不改变每个 `send` Promise 的完成权威。

### 5.5 验证门槛

- Protocol tests 覆盖成功/失败 Response、并发关联、早到 Response、Response timeout、重复 Request 保留期、Notification、heartbeat 运行周期隔离、非法报文、Session 窄端口和 dispose。
- Transport tests 覆盖 wire、拆分/重组、顺序、跨消息窗口、ACK、丢失/重复、重传、重连、失败本地最终性、`not-delivered | delivery-unknown`、序号不回绕、资源上限和非法 frame 清理。
- SDK tests 覆盖实例注入、connect 仅在 open/ready 后完成、connect/open 失败、disconnect/reconnect、Connection Generation gate、operationId 错误恢复和订阅。
- Server tests 覆盖 accepted Socket 组合、新连接要求 open、handler 与 Notification。
- 交付必须通过 `pnpm test:protocol`、`pnpm test:sdk`、`pnpm test:server`、`pnpm check` 和 `pnpm build`。
- 真实联调只验证 `session.open`，不得自动发送非空 `input.submit`。

## 6. 非目标

- 不实现或模拟 Bluetooth/GATT/MTU Transport。
- 不实现新的 WebSocket Transport 或通用不可靠链路协议。
- 不新增同时承担协议关联和链路传输职责的 Channel。
- 不让 Session 拥有 Transport state、connect/disconnect、重连策略或消息发送队列。
- 不提供公共 `sendBatch`，不向 Session 暴露 chunk、frame、window 或 ACK。
- 不对已经失败的 `send` 执行跨连接自动重放，也不承诺 exactly-once 业务执行。
- 不新增认证、授权、TLS、端到端加密、数据库或部署拓扑。
- 不把剪贴板、粘贴、React UI、输入历史或 Server 输入执行放入 Session/Transport。
- 不在本次 PRD 固定 Bluetooth 设备选择体验。

## 7. MVP 范围

### 7.1 本次包含

- 预创建 Transport 实例注入 Client。
- Session Transport Port 与 Managed Transport 生命周期面的职责拆分。
- Session 并发关联、Response timeout、Notification、handler 与 Codec 校验。
- Transport 内部连接恢复、完整消息并发队列、失败最终性和资源边界。
- Socket.IO Client/Server Transport 的完整可靠传输和生命周期迁移。
- Browser、Server、SDK、协议 definitions、exports、测试与中文文档的原子迁移。
- Session、Transport 与 SDK 的独立消费/发布边界。

### 7.2 本次不包含

- 跨 Socket 的逻辑 Session resume 或未完成消息重放。
- Bluetooth、WebSocket、认证、协议协商和持久消息队列。
- 新的输入业务功能、UI 重设计或 Server 部署变化。
- 长期兼容旧、新两套 Transport 接收接口。

## 8. 成功指标

### 8.1 主要指标

- **SM-1：组合边界成立。** Browser 示例只创建 Transport、注入 Client 并使用应用 API；Server 示例只组合 Session 与 Server Transport。验证 FR-1 至 FR-6、FR-29。
- **SM-2：并发关联正确。** 在 A 的 `send` 未完成时 B 已提交，且任意 Response 顺序下 100% 只完成匹配 Request。验证 FR-8 至 FR-12。
- **SM-3：可靠交付确定。** 受控 DATA/ACK 丢失、重复、断线和重连测试中，不发生部分/重复完整消息；每个失败 `send` 之后该消息新增本地 DATA frame 数为零，所有不确定结果均标为 `delivery-unknown`。验证 FR-15 至 FR-28。
- **SM-4：资源清理完整。** 所有 timeout、失败、disconnect 与 dispose 测试结束后，无 Pending Request、发送队列、重组缓存或 timer 泄漏。验证 FR-10、FR-14、FR-22、FR-23。
- **SM-5：全仓迁移通过。** 三组专项测试、`pnpm check` 和 `pnpm build` 全部通过，exports 与中文文档和实现一致。验证 FR-29 至 FR-32。

### 8.2 反指标

- 不以增加 Session 状态检查或 Session 发送队列换取表面稳定。
- 不以 Socket.IO 默认重连/离线缓冲替代产品级 Delivery 语义。
- 不以保留永久兼容别名或运行时双接口探测掩盖 breaking migration。
- 不通过实现未来 Bluetooth 来证明当前抽象。

## 9. 风险与护栏

- **跨连接重复风险：** 当前 wire 没有跨连接 resume/dedup；旧连接未完成 `send` 全部终结，禁止在新连接重放。
- **交付歧义风险：** 最终 ACK 丢失时，对端可能已收到完整消息；必须返回 `delivery-unknown`，SDK 不得通过创建新的 Operation 自动重试。
- **应用握手竞态：** Client 必须把 Transport connected 与应用 ready 分开，并防止旧 `session.open` 结果覆盖当前连接。
- **双重队列风险：** Session 不得等待前序调用完成；所有消息背压统一由 Transport 处理。
- **被动端误用：** Server accepted Transport 不具备主动找回同一 Socket 的能力；新 Socket 创建新对端组合。
- **发布迁移风险：** 包拆分和 API 变更必须原子迁移 workspace 调用方，并在首次独立发布前冻结名称和 semver 关系。

## 10. 开放问题

1. 最终 package 名称、Session/definitions/Codec 的物理归属和 peer dependency 范围是什么？
2. Managed Transport 的状态枚举、生命周期事件准确名称和重连诊断字段，以及 Session dispose API 的最终方法名是什么？
3. Client state subscription 与 Notification subscription 的最终方法名是什么？

以上均为 Architecture 的命名、发布与接口定型事项，不改变本文的层级职责、完成语义或验收边界；必须在实现 Story 拆分前固定。

## 11. 假设索引

- §4.2 FR-10：Response timeout 默认 10 秒，公共配置范围 1 秒至 120 秒。

该范围属于非阻塞安全假设，由 Architecture 在实现 Story 拆分前复核；若调整，必须仍为有限正数并同步更新测试和文档。
