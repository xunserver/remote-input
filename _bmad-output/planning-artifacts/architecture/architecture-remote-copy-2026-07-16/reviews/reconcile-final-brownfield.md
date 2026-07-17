# Brownfield Final Reconciliation

## Verdict

**CHANGES REQUIRED。** 四包目标、源码归属、Client/Server 组合方向和受信任本机/LAN 运行边界均可由当前仓库落地；未发现 Critical。以下 3 项 High 必须在 Story 拆分前收敛，否则原子迁移可能生成无效依赖、漏跑新包测试，或让自动验证违反仓库安全护栏。

## High Findings

### H-1 - 安装依赖与 subpath import 被混写，内部依赖类型仍不能直接落入 manifest

- **Spine：** AD-13 写成“Browser 直接安装 SDK + Socket.IO Transport/client”，依赖图也把 Browser 指向 `@remote-copy/transport-socket-io/client`；同时只说内部包使用 `workspace:^`，没有逐边固定 `dependencies` 与 `peerDependencies`（`ARCHITECTURE-SPINE.md:142-150,372-385`）。
- **当前现实：** pnpm manifest 只能安装包 `@remote-copy/transport-socket-io`，`./client` 和 `./server` 是 import subpath，不是可安装包名。当前所有 workspace 边都是普通 `dependencies` 且使用 `workspace:*`；SDK 只依赖 protocol，Client 只依赖 SDK，Server 只依赖 protocol。
- **风险：** 不同实现 Story 可能写出无效 dependency key，或分别把 protocol/session 设为普通依赖或 peer，造成消费者安装闭包与版本解析不一致。
- **Required correction：** 增加 manifest 级矩阵，明确 Browser/Server 安装 `@remote-copy/transport-socket-io`，代码分别 import `/client`、`/server`；逐项冻结 SDK -> Session/Protocol、Session -> Protocol、Transport -> Protocol/Socket.IO 的 dependency class 和版本范围，并明确是否完全不使用内部 peer dependency。

### H-2 - 新包拆分后，现有验证命令会静默漏掉 Session 与 Transport

- **Spine：** 迁移顺序只要求“root test 聚合”，Verification 只写“所有 package tests”，AD-13 又要求 CI 执行 golden fixtures，但没有固定最终命令或聚合关系（`ARCHITECTURE-SPINE.md:495-503,515-526`）。
- **当前现实：** 根脚本仅有 `test:protocol = pnpm --filter @remote-copy/protocol test`、`test:sdk`、`test:server`；不存在根 `test` task 或 CI workflow。Session 和 Socket.IO 的测试现在都依附于 protocol package。拆成 `@remote-copy/session` 与 `@remote-copy/transport-socket-io` 后，原 `pnpm test:protocol` 将不再覆盖它们。
- **风险：** 实现可以让既有三条命令全部通过，同时完全没有运行新 Session/Transport 测试和 same-major golden fixtures，错误地满足 PRD 的“三组专项测试”成功指标。
- **Required correction：** 冻结根命令合同：要么让 `test:protocol` 显式聚合 protocol + session + transport，要么新增 `test:session`/`test:transport` 并同步 PRD、AGENTS 与 CI；同时给 golden fixtures、exports 隔离和 Browser bundle 不含 Server runtime 指定实际执行入口。迁移还必须更新根 `tsconfig.json` project references/path mapping，避免新包在仓库级检查中不可见。

### H-3 - 当前真实 Socket.IO Server 测试与“禁止非空 input.submit”护栏冲突

- **Spine/AGENTS：** Repository verification 明确真实联调只发送 `session.open`，自动验证不得发送非空 `input.submit`（`ARCHITECTURE-SPINE.md:526`；`AGENTS.md:138`）。
- **当前现实：** `apps/server/tests/protocol-server.test.mjs:60-79` 通过真实 Socket.IO 连接三次发送非空 `input.submit`。测试注入了 fake InputQueue，因此当前不会触发剪贴板，但它仍违反护栏的字面合同，迁移后若依赖注入形状改变就可能意外接入真实输入执行。
- **风险：** 实现者只能在“保留关键 Server 去重集成测试”和“满足安全验证合同”之间任选其一；自动化重构还可能把该测试接回真实 `InputQueue`，触发本机剪贴板/粘贴副作用。
- **Required correction：** 在迁移清单中明确重写该测试：真实 Socket.IO smoke 仅验证 `session.open`；`input.submit`、全局 operationId 去重、subscriber rebind 和 conflict/expired/capacity 行为移入使用 message-only/in-memory Transport 与完全无副作用 handler 的集成测试。若希望保留当前 fake-queue Socket.IO 测试，则必须把护栏改成可机器判定的窄例外，而不是维持绝对禁令。

## Reconciled Without High Findings

- `Target Source Ownership` 与 `Atomic Migration Order` 已足以表明四包结构是目标态，而当前代码仍是 protocol + SDK 两包实现；未把旧实现错误描述为已完成。
- 单包 `@remote-copy/transport-socket-io` 暴露 `./client`/`./server`、共享私有 frame/GBN core，在 Node `exports` 与 Vite tree-shaking 下可实现。
- 当前 Server 默认 `0.0.0.0`、`cors.origin=true`、无认证，符合 Spine 明示的受信任本机/LAN 假设；Spine 已正确禁止将其视为公网安全方案。
