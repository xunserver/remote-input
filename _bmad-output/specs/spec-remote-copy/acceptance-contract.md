# Remote Copy Acceptance Contract

本 companion 只补充 SPEC kernel 与 Architecture Spine 未完整展开的验收边界；其余接口、状态机、wire 布局和默认值仍以 Architecture Spine 为准。

## Admitted Send Termination

- Transport admission 一旦接受某个 `send()`，该 Promise 必须在有限时间内 resolve 或 reject；有限性覆盖在发送队列中等待的时间，不只覆盖 DATA 已进入 window 后的 ACK/retry 时间。
- 实现必须从有界队列、单消息上限、窗口大小以及 progress/retry 预算推导出可测试的有限上界，或使用显式且有界的 queue deadline。任一方案都不得使已接受的 `send()` 永久 pending。
- 使用可控时钟验证：队列接近条数或字节上限、前序消息仅缓慢推进、ACK 停止推进、连接终止和显式关闭时，每个已接受调用都恰好 settle 一次；超限的新调用仍按 call-local `not-delivered` 失败。

## Inbound DATA And ACK

| Input | Required behavior |
| --- | --- |
| DATA `frameSeq === nextExpectedFrameSeq` 且 metadata canonical | 接纳 payload、推进期望序号，并发送新的累计 ACK。只有完整且长度一致的消息可向上交付。 |
| 重复或越序 DATA | 不接纳 payload、不推进接收状态，并发送当前 `nextExpectedFrameSeq` 累计 ACK。 |
| 重复或回退 ACK | 不推进 send base，也不重置 progress/retry deadline。 |
| ACK 确认尚未发送的 future frame | 作为非法 frame 终结当前 Connection Generation。 |
| 非 canonical chunk metadata、字段长度矛盾或超过资源上限的 frame | 作为非法 frame 终结当前 Connection Generation。 |

非法 frame 的清理由 Architecture AD-12 约束：清空当前 generation 的发送队列、窗口、重组状态和 timer，并按 DATA 是否可能离开本地把未完成 `send()` 分类为 `not-delivered` 或 `delivery-unknown`。golden-wire 和故障注入测试必须覆盖表中每一行。

## Duplicate Request Retention

- 正在执行的入站 Request 和 tombstone 保留期内的相同 `requestId` 不得再次执行 handler，并返回 `request.duplicate`。
- 已完成 Request 的 tombstone 默认最多保留 1024 条、最长 10 分钟，以先达到的边界为准。
- 达到数量上限时淘汰最早的 tombstone；不得通过淘汰仍在执行的 handler 记录来释放容量。
- 有限保留不改变发送方在同一 Session 生命周期内不得复用 `requestId` 的要求，也不构成业务级无限幂等保证。

## Portability Proof

- Session/Transport 的公开 contracts 和 message-only 测试替身必须能在不引入 React、DOM、Node HTTP、剪贴板或下游输入执行类型的 fixture 中完成类型检查。
- Browser bundle 检查与 Server import 检查继续按 Architecture Verification Contract 执行；可替换性不得通过实现虚构的 Bluetooth Transport 来证明。
