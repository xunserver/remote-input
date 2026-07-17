---
id: SPEC-remote-copy
companions:
  - ../../planning-artifacts/architecture/architecture-remote-copy-2026-07-16/ARCHITECTURE-SPINE.md
  - acceptance-contract.md
  - ../../../AGENTS.md
sources:
  - ../../planning-artifacts/prds/prd-remote-copy-2026-07-16/prd.md
  - ../../planning-artifacts/prds/prd-remote-copy-2026-07-16/addendum.md
---

# Remote Copy Client、Session 与 Transport 分层规范

> Canonical record: `.memlog.md`. This file is a derived projection for downstream work.

## Why

remote-copy 需要一条可替换的远程输入链路，使应用语义、协议关联、编码校验和链路可靠性各有唯一所有者。Browser 开发者应能在自行选择的 Transport 上获得稳定的 Client API；Server 与 Transport 实现者应能独立复用 Session；连接恢复、交付结果和长期 Operation 状态在不同传输实现下必须保持一致且可验证。

## Capabilities

### CAP-1 可组合的远程输入客户端

**Intent：** Browser 调用者可使用自行选择的 Transport 建立远程会话、提交文本、查询 Operation、订阅状态与通知，并在显式关闭后再次连接。

**Success：** 在任一符合契约的 Client Transport 上，`connect()` 仅在当前 Connection Generation 的 `session.open` 成功后完成；ready 后 `inputText()`、Operation 查询和订阅分别委托到正确的 Session 请求或应用投影；状态、通知和 Operation 更新只反映当前有效周期，旧 cycle/generation 结果不能污染当前状态；未 ready 的业务调用确定性失败；`disconnect()` 停止恢复且同一 Client 可再次连接；SDK 不依赖具体 Transport。

### CAP-2 通用协议会话

**Intent：** Browser 与 Server 可通过同一 Session 能力交换经过校验的类型化请求、响应、入站请求、通知和心跳，且每次请求独立完成。

**Success：** 仅使用完整消息 Transport 测试替身即可证明：请求在发送前登记关联；并发请求与逆序或早到响应不串配；Response Timeout 从消息交付后独立计算；单次发送失败不影响其他请求；合法入站 Request 只执行匹配 handler 并返回关联 Response；非法输入不进入 handler；heartbeat 只匹配当前 run 的 Pong，`stopHeartbeat()` 后的迟到 callback 失效；`dispose()` 后无 listener、pending 或 timer 遗留。

### CAP-3 完整消息可靠传输

**Intent：** 上层可并发发送和接收完整字节消息，并获得可靠、有序、保留边界且具有背压的双工交付。

**Success：** Transport 契约测试证明从空消息到最大消息均无部分、合并、重复或倒序上行交付；每个 `send()` 只在对端确认整条消息后独立成功；容量受限时返回可识别失败；Transport 在 callback 返回后不得修改或复用已交付字节。

### CAP-4 有界连接恢复与确定失败

**Intent：** 调用者可按角色建立或接纳、观察和关闭连接；主动端 Transport 可在有界预算内自行恢复；每次发送获得不会被后续恢复反转的确定本地结果。

**Success：** 生命周期测试证明 Connection Generation 单调且状态快照无丢失；主动端任一时刻至多一个连接或恢复过程且恢复和时限有界；被动 accepted Server Transport 从不主动恢复已关闭的 Socket；显式关闭可取消恢复并允许主动端后续重连；不可用期间的新发送立即失败；错误区分 `not-delivered` 与 `delivery-unknown` 以及 call-local 与 connection-fatal 影响；失败后不重放消息或泄漏资源。

### CAP-5 Socket.IO 双端互操作

**Intent：** Socket.IO Client 与 accepted Server Socket 可作为同一完整消息 Transport 能力的双向互操作实现。

**Success：** golden-wire 与故障注入测试证明：大消息可透明拆分和合法重组；连续消息保持边界与顺序；丢失、重复和乱序不会造成部分或重复交付；Transport ACK 与协议 Response 相互独立；每个新 Connection Generation 隔离旧状态；Client 可主动恢复，而 Server accepted Transport 不恢复已关闭的 Socket。

### CAP-6 独立消费与协议治理

**Intent：** Browser 与 Server 可只安装和版本化各自需要的 SDK、Session 与 Transport，同时共享唯一的应用协议契约。

**Success：** 依赖图证明 Browser 不加载 Server runtime 或默认 Transport、Server 不依赖 SDK、协议类型与 schema 只定义一次、同 major 兼容性由 fixtures 保证；workspace 调用方、测试和中文文档原子迁移到新 API，旧 factory、alias、adapter 和双接口探测均不存在。

### CAP-7 长期 Operation 一致性

**Intent：** 调用者可提交、查询和持续观察长期远程输入 Operation，并在交付不确定或连接变化后避免陈旧状态回退和不安全的重复执行。

**Success：** `inputText()` 在发送前创建或复用 `operationId`，ID 创建后的失败始终返回该 ID；调用者可用同一 ID 查询或显式重试；公共状态仅为 `accepted`、`processing`、`succeeded`、`failed`；权威缓存只接受严格更高且迁移合法的 `revision`，terminal 状态不回退；Transport ACK 与协议 Response 不冒充 Operation 完成；同一 Server 进程内重复 ID 保持幂等。

## Constraints

- 必须保持 `RemoteInputClient -> ProtocolSession -> MessageCodec -> MessageTransport` 单向分层；应用语义、协议关联、编码校验和链路可靠性各有唯一所有者，不得引入跨层 `Channel`、重复队列或重复状态机。
- SDK 接收调用方创建的 Transport 且不依赖具体实现；Browser 只消费 SDK 与选定的 Client Transport，Server 只消费 Session 与 Server Transport；Protocol、Session、Socket.IO Transport 与 SDK 必须可独立消费和发布。
- `packages/protocol` 是应用协议唯一事实源；所有入站字节必须经过运行时校验，禁止用类型断言绕过不可信输入边界。
- Session 只依赖完整消息 `send/receive` 数据面且不读取或控制 Transport 生命周期；Client/Server 组合根编排生命周期，Transport 独占连接、恢复、排队、分片、ACK、重传和完整消息交付结果。
- Transport 必须可靠、有序且保留完整消息边界；发送失败是本地最终态，失败消息不得跨 Connection Generation 重放；Transport ACK、协议 Response 与 Operation completion 是三种独立完成语义。
- `requestId`、`operationId`、`heartbeatId` 与 Transport 序号必须保持独立命名空间；跨层错误以稳定结构字段判别，明确区分 `not-delivered` 与 `delivery-unknown`，不得依赖错误文本或跨包 `instanceof`。
- Operation 公共状态只允许 `accepted | processing | succeeded | failed`；`stage` 承载下游阶段，权威通知必须携带递增 `revision`，SDK 只接受更高 revision 和合法迁移。
- Session、Transport、SDK 和 Server 的队列、缓存、请求数与时间预算必须有界；failure、close 和 dispose 路径必须清除 listener、Promise、timer、队列和重组资源。
- Session/Transport 的公共 contracts 不得依赖 React、DOM、Node HTTP、剪贴板或下游输入执行；可替换性必须在 Browser 与 Server 环境之外通过类型和测试替身成立。
- 当前拓扑保持 Browser 到单一 Node/Socket.IO Server，Server 同时托管静态资源；安全边界仅限受信任本机或 LAN，不构成公网安全方案；库默认不得记录 input text、协议 body 或 frame payload。
- 使用严格 TypeScript 和判别联合；迁移是 private workspace 的原子 breaking change，不保留旧 API alias、adapter 或双接口探测，并同步更新 exports、测试、中文 README 与架构文档。
- `AGENTS.md` 的工作区、安全和验证规则继续生效；其中由 `packages/protocol/implementations` 承载 Session/Transport、SDK 从 protocol 获取 Socket.IO Transport 的描述仅代表 brownfield 现状，目标归属以 Architecture AD-13 为准，并在原子迁移中同步更新 `AGENTS.md`。
- 自动真实联调只能发送 `session.open`，不得发送非空 `input.submit`；输入成功路径使用无 OS 副作用的 fake/direct handler。
- 所有实现与验收必须服从 adopted Architecture Spine 的 AD-1 至 AD-18；精确接口、状态机、时限、资源上限、wire 格式、恢复策略和迁移顺序以该 companion 为准。
- Architecture Spine 未展开的排队终止、非法 wire 处理和 Request tombstone 淘汰验收以 `acceptance-contract.md` 为准。

## Non-goals

- 不实现或模拟 Bluetooth/GATT/MTU、WebSocket 或其他 Transport，也不固定 Bluetooth 设备选择体验。
- 不实现跨连接 Session resume、失败消息 replay、持久 delivery 或 exactly-once 业务执行。
- 不实现认证、授权、TLS、端到端加密、公网部署防护、数据库、跨进程 Operation 持久化或多 Server 幂等域。
- 不新增协议协商、压缩、在线 wire 参数协商或新的 wire major。
- 不重设计 UI，不持久化输入历史，也不改变剪贴板、粘贴或其他下游输入执行能力。
- 不提供公共 `sendBatch`，不向 Session 暴露 chunk/frame/window/ACK，也不引入同时承担协议和传输职责的 `Channel`。
- 本次不决定 registry、provenance、发布自动化或长期支持策略。

## Success Signal

Browser 示例只创建并注入 Socket.IO Client Transport 后使用 SDK；Server 示例只组合 Server Transport 与 Session。关联、故障注入、恢复和资源清理测试不得出现串配、部分消息、重复、乱序、失败后复活或资源泄漏；`pnpm test:protocol`、`pnpm test:sdk`、`pnpm test:server`、`pnpm check` 和 `pnpm build` 全部通过，exports、中文文档和实现一致；自动真实联调只执行 `session.open`。
