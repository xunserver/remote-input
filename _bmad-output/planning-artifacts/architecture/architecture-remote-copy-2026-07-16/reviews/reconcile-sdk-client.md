# SDK / Client 输入对账

## Verdict

架构主方向与现有分层一致，但在进入实现前仍需对账。当前正文把若干现有内部行为升级成了公共规则，同时又静默改变了公开连接状态、`RemoteInputClientOptions` 和 Transport 订阅接口；如果按 Structural Seed 直接实现，现有 Client、SDK 测试和中文 README 不能无改动继续工作。

## Findings

- SDK 状态机与当前公开 `ConnectionState` 不兼容。Spine 287-303 引入 `Opening`、`Disconnecting` 并移除 `Connected`，但当前联合是 `idle | connecting | connected | ready | disconnected | error`（`packages/sdk/src/types.ts:11`）。Client 会显示该联合、在 `connected` 或 `ready` 时保存 URL/关闭连接弹窗，并只在 `connecting` 时禁用连接与重连（`apps/client/src/hooks/use-remote-input.ts:73-79`、`apps/client/src/components/connection-dialog.tsx:47`、`apps/client/src/components/connection-status.tsx:85-88`）。正文必须决定保留现有公共值，还是把状态变更列为 breaking change并同时给出 Client 迁移映射。

- Structural Seed 没有定义完整 `RemoteInputState`，不足以保护现有 Client 契约。当前公开字段包括 `connectionState`、`transportKind`、`peer`、`capabilities`、`peers`、`currentOperation`、`isSubmitting`、`error`（`packages/sdk/src/types.ts:30-39`），Client 实际消费其中除 `transportKind` 外的全部字段（`apps/client/src/hooks/use-remote-input.ts:145-155`）。Spine 278-285 的 ownership 表不能替代精确类型；应明确逐字段保留、重命名或删除策略。

- `RemoteInputClientOptions` Seed 是未声明的破坏性改造。Spine 251-262 删除了当前公开的 `createRequestId`，把 `requestTimeoutMs`、`heartbeatIntervalMs`、`heartbeatTimeoutMs` 从顶层移入 `session`，并新增 `createSession`；当前类型和测试直接使用旧字段（`packages/sdk/src/types.ts:47-55`、`packages/sdk/tests/remote-input-client.test.mjs:67-78`）。必须选择保留旧形状、提供兼容别名和弃用期，或明确 major-version migration。

- 新增 `createSession` 缺少组合根所有权规则。正文没有规定 factory 是否可异步、SDK 是否仍向自定义 Session 注入 timeout/ID 工厂、连接失败后由谁 disconnect、factory 返回已连接 Session 是否非法，以及 `createTransport` 与 `createSession` 同时提供时谁优先。没有这些规则，Spine 50、130、252-262 所称的依赖注入会产生两套不兼容装配方式。

- 并发连接规则内部矛盾且与现状不一致。Spine 154 要求并发 connect/disconnect “共享各自的 in-flight Promise”，AD-9 又要求每次 `connect()` 创建新 Transport/Session；当前行为是后一次 connect 递增 generation、淘汰并 disconnect 前一次异步创建出的 Transport，而两个调用各自完成（`packages/sdk/src/remote-input-client.ts:94-119`、`packages/sdk/tests/remote-input-client.test.mjs:133-154`）。必须区分“同 target 去重”与“新 connect supersede 旧 connect”，并定义 connect/disconnect 交错时每个 Promise 的结果。

- SDK 错误兼容面没有落到可实现契约。当前公开导出 `SendInputError`、六个 `SendInputErrorCode`、四个 `RemoteInputErrorCode`，Client 对 `peer-error`、`invalid-message`、`transport-connect-failed` 有固定展示分支（`packages/sdk/src/index.ts:1-15`、`packages/sdk/src/types.ts:14-28`、`apps/client/src/hooks/use-remote-input.ts:166-183`）。Spine 120-124、405-415 只写“稳定错误码”及泛称 resource/busy error，没有列出保留码、Transport/Protocol 到 SDK 的确定映射，也未说明 `SendInputError` 是否继续导出。

- `MessageTransport.subscribe()` 改名为 `receive()` 是公开高级注入面的 breaking change，不只是内部命名整理。当前 protocol contract、中文 SDK README 和所有自定义/内存 Transport 都实现 `subscribe(listener)`（`packages/protocol/src/definitions/message-transport.ts:38-39`、`packages/sdk/README.md:70`、`packages/sdk/tests/remote-input-client.test.mjs:29-32`）；Spine 84-88、203-211 改为 `receive`。AD-6 仍标记 ASSUMPTION，Deferred 476 又保留再次评审，故不能同时作为 Structural Seed 的既定接口；应在实现前定案并写兼容适配策略。

- AD-14 的“OperationStore 是唯一快照所有者”与现有 Client 历史模型表述冲突。Client 把 operation state/stage/message/progress 复制进持久化 history，并持续用 `currentOperation` 更新它（`apps/client/src/hooks/use-remote-input.ts:52-71`、`apps/client/src/hooks/use-remote-input.ts:114-139`）；Spine 449 又说历史仍归 Client。正文应把规则收窄为“SDK 是当前连接 live operation 的唯一权威源，Client 可保存只读历史投影”，否则实现者可能删除现有历史状态或制造双写禁令。

- disconnect 后保留 operation 快照是基于当前实现的推断，不是已公开语义。当前 `disconnect()` 展开原 state，因此保留 `currentOperation`/operation Map，而新 `connect()` 才清空（`packages/sdk/src/remote-input-client.ts:94-104`、`packages/sdk/src/remote-input-client.ts:143-155`）；README 只承诺 revision 去重，没有承诺跨断线保留。AD-14 应标为显式新决策，并补充 fatal error、主动 disconnect、session.open 失败三种路径是否一致，避免把偶然实现固化成契约。

- OperationStore 没有容量、淘汰和 listener 清理策略。Spine 132-136、435-449 将其升级为独立长期组件，但只规定 revision 合并和 connect 清空；一个长连接可积累无限 operationId，peer 也可通过通知放大 Map，且 `subscribeOperation` 的 listener 生命周期与被淘汰状态未定义。目标文档已经要求 operation Map 有上限（`docs/architecture.md:636-649`），Spine 应给 SDK cache 上限或明确为何由单-active policy形成严格边界。

- 订阅的 replay 与异常语义缺失。当前 `subscribe`、`subscribeOperation` 和 `subscribeNotification` 都只接收注册后的事件，不立即回放现值；Client 因此先 `getState()` 再订阅（`packages/sdk/src/remote-input-client.ts:66-91`、`apps/client/src/hooks/use-remote-input.ts:36-46`）。Spine 149、155 新增“幂等取消”和“一个 listener 抛错不阻塞其他 listener”，后者与当前直接循环调用行为不同（`packages/sdk/src/remote-input-client.ts:270-306`）。应明确是否保持 future-only、是否同步调用、异常送往何处，并把行为变化纳入测试和兼容说明。

- `sendInput()` 成功后的 cache 后置条件没有写成契约。当前 SDK 在 resolve 前保证 cache 至少已有真实通知或 synthetic revision 0，Client 随后立即调用 `getOperationStatus()`，仍保留自己的 fallback（`packages/sdk/src/remote-input-client.ts:181-196`、`apps/client/src/hooks/use-remote-input.ts:109-125`）。Spine 描述 synthetic replacement，却未明确 `sendInput` resolve 后 `getOperationStatus(operationId) !== null`；若 OperationStore 拆分时改变时序，Client 会退回第二套 synthetic 状态。应固定该后置条件并决定移除还是继续支持 Client fallback。

- “真实通知可替换同 revision synthetic accepted”有代码依据但与中文文档的“只接受更新 revision”字面规则不一致。现实现确有该例外（`packages/sdk/src/remote-input-client.ts:279-289`），而 `packages/sdk/README.md:87` 和 `docs/architecture.md:632` 都只描述递增 revision。Spine AD-14 应明确 synthetic 是 SDK 本地占位、同 revision 替换仅适用于 synthetic-to-authoritative，不得放宽两个真实状态之间的严格递增规则，并同步中文文档。

## Reconciliation Result

可直接保留的主线包括：`connect()` resolve 时达到 ready、SDK 执行 `session.open` 后启动心跳、SDK 生成 operationId 而 Session 生成 requestId、单 active operation policy、按 revision 合并、显式重连、异步 `createTransport` 与过期 generation 淘汰。上述 findings 定案后，架构才足以作为不误伤现有 Client 的实现基线。
