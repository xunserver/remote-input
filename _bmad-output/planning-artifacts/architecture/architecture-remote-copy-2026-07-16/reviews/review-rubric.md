# Reviewer Gate - Rubric Walker

## Verdict

**NEEDS REVISION BEFORE FINAL。** 机械 lint 为零问题，主要分层、Codec/Transport 边界、wire、状态所有权与运行拓扑均完整；但 Server 幂等域、断线终态和 SDK 错误映射仍允许独立实现产生不兼容行为，其中幂等规则与其 `Prevents` 目标直接相反。

## Deterministic Pass

执行：

```text
uv run .agents/skills/bmad-architecture/scripts/lint_spine.py \
  --workspace _bmad-output/planning-artifacts/architecture/architecture-remote-copy-2026-07-16
```

结果：`ok: true`，0 findings。

## High-Priority Findings

### [HIGH] R-1：跨连接 operation 规则不能阻止重复副作用

**证据**

- AD-10（line 113）规定 `operationId` 关联长期 operation、查询、通知和业务重试。
- AD-18 的 `Prevents`（line 160）声称防止断线后重复执行已接受副作用。
- AD-18 的 `Rule`（line 161）却把去重键固定为 `(connectionId, operationId)`，让已 accepted job 在断线后继续执行，同时规定新连接属于新去重域且不能查询旧 operation。

**为什么 Rule 未阻止 Prevents**

连接在 Server accepted 后、Client 收到 Response 或 terminal 状态前断开时，旧 job 会继续执行；Client 使用同一个 operationId 在新连接重试时，由于 connectionId 已变化，Server 会再次入队并执行同一副作用。该 Rule 实际创建了它声称要阻止的重复执行窗口。Server operation 保留/淘汰期限也未固定，因此即使在同一长连接中，记录淘汰后重试仍可能重复执行。

**必须处置**

在 final 前选择并固定一种一致语义：

1. 提供跨连接稳定的 client/session identity，以 `(stableClientId, operationId)` 去重，并固定 operation 记录保留/淘汰规则；或
2. 明确 operationId 只在单连接 generation 内幂等，SDK/应用断线后绝不自动或手动重提旧 operationId，同时删除 AD-10 的“业务重试”和 AD-18 的跨断线防重承诺。

不能继续同时保留“旧 job 继续执行”“新连接新去重域”和“跨断线不重复执行”三项。

### [HIGH] R-2：远端断线的公开终态在 `error` 与 `disconnected` 之间矛盾

**证据**

- AD-12（line 125）把“断线”列为 connection-fatal。
- AD-9（line 107）规定 fatal 只发布一次 error 并进入 `state=error`，底层 socket close 不得覆写。
- Transport 状态机（lines 350-363）把 `Connected -> Disconnected: disconnect` 作为唯一断线路径。
- Error And Cleanup Matrix（line 458）把“主动 disconnect / 远端断线”合并为同一行，却未规定 Transport 和 SDK 最终 state。

**不兼容后果**

Client Transport 可以把远端链路丢失实现为 `error`，Server Transport 可以实现为 `disconnected`；Session 虽能清理两者，但 SDK 错误展示、重连判断、事件序列和终态测试会分叉。主动关闭也可能被错误上报为 fatal。

**必须处置**

分别固定两条状态转换和事件序列：

- 显式本地主动 `disconnect()`：幂等清理，最终 `disconnected`，不产生 fatal error。
- 非预期远端断线：明确选择 `error` 或 `disconnected + fatal error event` 中的一种，并要求 Client/Server Transport 一致；同时同步 AD-9、AD-12、状态机、矩阵和测试。

### [HIGH] R-3：SDK 对 Transport 资源错误没有唯一公共映射

**证据**

- AD-12（line 125）要求保留现有 `SendInputErrorCode` / `RemoteInputErrorCode` 映射。
- Structural Seed（lines 200-215）新增 `message-too-large`、`queue-full`、`sequence-exhausted` 等 TransportError code。
- Error Matrix（line 455）要求队列满映射为 “busy/resource error”，但现有 SDK 没有 resource code；`input-busy` 当前表示已有 active operation，并不等同于 Transport 队列耗尽。
- 同一矩阵对 message-too-large、queue-full、remote ProtocolError 和一般发送失败只给出类别描述，没有固定到现有 SDK code。

**不兼容后果**

SDK 实现者可能把 `queue-full` 映射为 `input-busy`、`request-failed`、`transport-error` 或新增 code；Client UI 会据此采取不同重试和提示行为，违反 AD-2/AD-12 所承诺的稳定错误契约。

**必须处置**

增加最小的规范映射表，逐项固定 TransportErrorCode、ProtocolResponseError、request timeout、validation error 到 `SendInputErrorCode`、`RemoteInputErrorCode` 和连接状态的结果。若需要新增 SDK code，应作为明确公共 API 决策，而不是由实现者推断。

### [HIGH] R-4：新公开 lifecycle/receive 规则未被 Verification Contract 锁定

**证据**

- AD-6（line 89）将 `subscribe -> receive` 定为原子公共契约迁移，并要求幂等 Unsubscribe、listener 隔离和单 Session 所有权。
- AD-9（line 107）改变 Transport 并发 connect 为复用 in-flight Promise，并规定 fatal 单次事件及 SDK connect generation 淘汰。
- Verification Contract 的 Transport 行（line 503）未要求 `receive` 的订阅时机、取消订阅幂等、listener 异常隔离、旧 `subscribe` 消失、并发 connect Promise 复用或主动/远端断线事件序列；SDK 行（line 504）也未明确旧 connect Promise 必须 reject 且迟到 Transport 必须释放。

**不兼容后果**

这些是本次重构最主要的公共行为变化，但现有验证清单允许 Client/Server/test doubles 在 receive 与 lifecycle 语义上各自实现并仍通过列出的测试。

**必须处置**

把上述行为逐项加入 Transport 和 SDK Required coverage，尤其锁定 R-2 最终选定的断线事件序列。

## Rubric Coverage Summary

| Rubric dimension | Result | Notes |
| --- | --- | --- |
| 真实分歧点 | PARTIAL | 三层、Codec、wire、pending Map 已固定；跨连接幂等和错误映射仍分叉。 |
| AD 可执行性 | PARTIAL | 大多数 Rule 可直接测试；AD-18 未实现其 Prevents，AD-12 终态不唯一。 |
| Deferred 安全性 | PASS | 当前 Deferred 均有现行默认或不进入本次实现；没有把当前三层契约重新打开。 |
| Brownfield 继承 | PARTIAL | 目录、协议、operation 状态、运行拓扑已继承；现有 connection-scoped 去重被提升为承诺，却未携带其重复副作用边界。 |
| 运行环境 | PASS | Browser -> 单 Node Server、Socket.IO endpoint、静态托管及无新基础设施已固定。 |
| 状态与数据 | PARTIAL | 分层所有权、revision、容量已固定；Server operation 跨连接身份与保留期未闭合。 |
| 错误与清理 | PARTIAL | fatal 清理完整；断线终态和 SDK code 映射不唯一。 |
| 测试 | PARTIAL | wire/Session/SDK 主链覆盖充分；新 receive/lifecycle 公共行为缺少强制测试。 |

## Gate Decision

R-1、R-2、R-3 会让独立实现产生可观察且不兼容的业务或公共 API 行为，应在 spine 改为 `final` 前解决。R-4 应随前三项同步进入 Verification Contract，避免修订后的规则再次漂移。
