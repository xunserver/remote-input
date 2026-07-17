# 输入对账：Brownfield 仓库约束、实现与测试

## 输入

- `AGENTS.md`
- `package.json`、`pnpm-workspace.yaml`、`turbo.json`
- `packages/protocol/package.json`、`packages/sdk/package.json`、`apps/client/package.json`、`apps/server/package.json`
- `packages/protocol/src/definitions/**`
- `packages/protocol/src/implementations/**`
- `packages/sdk/src/**`
- `apps/server/src/socket-io/protocol-server.ts`、`apps/server/src/input/inputQueue.ts`
- `apps/client/src/hooks/use-remote-input.ts`
- `packages/protocol/tests/**`、`packages/sdk/tests/**`、`apps/server/tests/**`
- 对账目标：`prd.md`、`addendum.md`

## 对账结论

PRD 与附录已经准确保留仓库要求的四层依赖、Socket.IO DATA/ACK wire、Go-Back-N/累计 ACK、默认资源上限、Request/Response 与 Operation 的标识隔离、Operation 公共状态以及五条验证命令。以下五项仍需在定稿或 Architecture/Stories 入口明确处理；否则目标契约无法从当前 brownfield 实现直接推导或验收。

## Gap 1：主动端自动恢复的调用语义仍未冻结，且当前实现完全不具备该能力

**证据**

- PRD FR-19 要求主动端 Transport 独占连接恢复，FR-27 又要求旧 generation 所有未完成 `send` 失败、恢复只服务之后的新消息。
- 当前 `SocketIoClientTransport` 明确设置 `reconnection: false`（`packages/protocol/src/implementations/socket-io-client-transport.ts:53-58`）。
- 当前 `send()` 在未连接时立即抛错，不会建链、排队或等待恢复（同文件 `:236-242`）。
- 当前测试只证明显式 `connect()`、connect cancellation/replacement、断线清理和旧 socket 事件隔离；没有自动恢复或恢复期间新 `send` 的测试。

**缺口**

PRD 尚未确定意外断线后究竟采用后台重连还是下一次 `send` 按需建链，也未固定 `disconnected/reconnecting` 期间新 `send` 是接收排队还是立即失败。这会直接改变 Session 看到的 `send()` 结果、Client 的 ready/open gate，以及“自动重连只服务之后新提交消息”的可执行含义。

**所需处置**

在进入 Stories 前冻结一张主动端状态/调用表，至少覆盖：首次 `connect`、意外断线、恢复中 `send`、恢复预算耗尽、显式 `disconnect`、再次显式 `connect`、新 generation 通知和旧 generation 全队列失败范围。继续保持：任何已经 reject 的消息不得跨 generation 复活。

## Gap 2：独立发布是已确认目标，但当前 package 拓扑与清单尚未形成可实施迁移契约

**证据**

- `@remote-copy/protocol` 和 `@remote-copy/sdk` 当前均为 `private: true`。
- `@remote-copy/protocol` 当前同时导出 Codec、Session、Socket.IO Client/Server Transport，并直接依赖 `socket.io-client`（`packages/protocol/package.json`）。
- SDK 当前只依赖 `@remote-copy/protocol`，并默认导入具体 `SocketIoClientTransport`；Browser app 当前只安装 SDK，没有显式 Transport package。
- PRD FR-29 要求 SDK、Session 能力和具体 Transport 独立安装、版本化和发布，但开放问题仍把物理归属、package 名称、exports 和 peer dependency 全部留待后续。

**缺口**

这是实质性 workspace/package 拆分，不只是 export rename。若 package 边界未冻结，无法准确拆 Story、配置 Turbo 构建依赖、制定 publish 顺序、声明 peer dependency 或验证 Browser/Server 的真实安装闭包。

**所需处置**

Architecture 必须在 Epics/Stories 前给出最终 package 图和迁移表：definitions/Codec/Session 归属、Client/Server Transport 是否同包、SDK 与 Transport 的依赖/peer 关系、`private`/publish 配置、root/subpath exports、版本兼容范围和 lockfile/build graph 变化。PRD 可不固定具体包名，但必须把该架构决策标为进入 Epics 的前置条件。

## Gap 3：PRD 要求结构化、可区分错误，但当前公共契约只有 `unknown` 与 message string

**证据**

- `TransportEvent.error` 是 `unknown`（`packages/protocol/src/definitions/message-transport.ts:5-8`）。
- 当前 Transport 与 Session 主要抛普通 `Error`；Transport tests 通过正则匹配英文 message 判断失败类别。
- SDK 当前把除 `ProtocolResponseError` 外的大多数请求失败统一映射为 `transport-error`/`request-failed`（`packages/sdk/src/remote-input-client.ts:197-208`），不能稳定区分 Delivery Failure 与 Session Response Timeout。
- PRD FR-22、FR-23 和 NFR 5.4 已要求 call-local/fatal、结构化错误、cause 保留和 Client 六类错误区分，但没有定义最小公共 code 集合及跨层映射。

**缺口**

仅写“可识别”不足以验收，也无法保证独立发布的 Transport 与 SDK 之间不依赖实现专属字符串。当前实现到目标的差异比附录中的普通重命名更大：definitions、每条失败路径、Session 转译、SDK 错误联合和测试断言都要一起迁移。

**所需处置**

在 Architecture 固定稳定的最小错误契约和映射矩阵，至少覆盖：not-connected/cancelled、connect budget exhausted、message too large、queue capacity、delivery failed、connection-fatal、response-timeout、protocol validation 与 remote protocol error；明确 `cause`、fatal/retryable 和 public SDK code 哪些稳定、哪些仅诊断。

## Gap 4：Operation revision 的仓库硬约束与当前 SDK 同 revision 特例没有被显式调和

**证据**

- `AGENTS.md` 要求 SDK 只接受比缓存更新的 `revision`。
- PRD FR-31 只笼统要求“保留 revision 去重”，未在可验证结果中明确必须满足 `incoming.revision > cached.revision`。
- 当前 SDK 对 synthetic status 有例外：真实状态可以用相同 revision 替换 synthetic 状态（`packages/sdk/src/remote-input-client.ts:279-285`）；`sendInput` 还会创建 synthetic `revision: 0`（同文件 `:186-195`）。

**缺口**

“严格递增才接受”和“允许同 revision 替换 synthetic”是不同公共行为。当前 Server 首个真实 revision 为 1，因此可以移除该例外而不影响当前 Server，但未来 Transport/Server 实现不能依赖未写明的特例。

**所需处置**

PRD 验收应明确选择：严格只接受更大 revision，或正式定义 synthetic 投影不进入 authoritative revision cache。若保留同 revision 替换例外，则必须同步修改 `AGENTS.md` 的硬约束并补测试；不能只写“revision 去重”。

## Gap 5：验证命令正确，但当前测试套件证明的是旧生命周期契约

**证据**

- 根脚本完整提供 `pnpm test:protocol`、`pnpm test:sdk`、`pnpm test:server`、`pnpm check` 和 `pnpm build`，与 PRD/`AGENTS.md` 一致。
- 当前 Session tests 明确断言 Session `connect/disconnect`、Transport state 转发、reconnect 立即清空 pending、heartbeat timeout 主动断开 Transport；这些都与目标窄数据端口相反。
- 当前 SDK tests 只覆盖 `createTransport(url)` factory、`connect(url)`、`sendInput` 和手动断开，不覆盖实例注入、Transport 自恢复、generation open single-flight 或 ready 恢复。
- 当前 Transport tests 没有覆盖自动重连、恢复中 `send`、跨 generation failure finality、公开错误 code、空消息、frame/message sequence 耗尽后的目标 fatal 范围。

**缺口**

PRD 5.5 的测试主题是正确的，但不能把现有 suite 当作目标行为的既有证明。特别是 Session disconnect 后让已交付 Pending Request 等 Response timeout、heartbeat failure 不控制 Transport、以及 Client 对每个新 generation 恰好执行一次 `session.open`，都需要替换旧断言而不是只追加 happy-path 测试。

**所需处置**

Story 验收矩阵应逐项标记“保留现有测试 / 改写旧测试 / 新增测试”，并至少新增上述目标场景；package 拆分后还要把 export 隔离和 Browser/Server 依赖闭包纳入测试或静态检查。真实联调继续只验证 `session.open`，不得发送非空 `input.submit`。

## 已确认无缺口的关键约束

- 分层保持 `RemoteInputClient -> ProtocolSession -> MessageCodec -> MessageTransport`，没有重新引入 Channel。
- Socket.IO 使用单一 `protocol:frame`；DATA 28 bytes、ACK 8 bytes、大端、magic/version/kind 和累计 ACK 语义准确。
- 序号从 0 开始、DATA 最大 `0xfffffffe`、最终 ACK `0xffffffff`，不跨连接回绕。
- 默认 16 KiB chunk、8 帧窗口、2 秒 ACK deadline、最多 3 次重传、10 秒重组无进展、256 KiB 单消息、128 条/4 MiB 队列均与代码和 `AGENTS.md` 一致。
- Transport ACK、协议 Response、Operation completion 的含义分离准确；Operation state、`stage` 与 `succeeded` 语义准确。
- `requestId`、`operationId`、`heartbeatId`、`messageId/frameSeq` 的所有权隔离准确。
- 自动验证安全护栏和五条全仓验证命令准确。
