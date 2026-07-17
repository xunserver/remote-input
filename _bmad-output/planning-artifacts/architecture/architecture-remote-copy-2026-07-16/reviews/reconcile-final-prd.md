# Final PRD Reconciliation

**Verdict:** CHANGES REQUIRED before finalization.

The spine preserves the central layering, package split, generation isolation, delivery finality, operation semantics, Socket.IO wire contract, and atomic migration. Six binding items are incomplete or contradictory: 3 High and 3 Medium.

## High

### H-1 - Client readiness deadline is conflated with Transport connect deadline

- **Source:** PRD FR-5 (`prd.md:112-118`) and addendum (`addendum.md:122`) require a **30-second total `client.connect()` deadline**, containing a **10-second initial Transport connect deadline**. An open ProtocolError, invalid result, or total deadline expiry must close the current generation, enter Client `error`, and reject `connect()`.
- **Spine:** AD-9 says “初次显式 connect ... 最多 10 秒” (`ARCHITECTURE-SPINE.md:116`), which makes the Client deadline 10 seconds rather than 30. Its open-failure rule only disposes/stops heartbeat (`:118`) and does not require closing the connected generation.
- **Required correction:** distinguish the 30-second Client readiness budget from the 10-second Transport attempt budget. Bind all initial and later-generation `session.open` ProtocolError/validation/deadline failures to closing that generation, clearing ready/stopping heartbeat, entering `error`, and rejecting the active readiness promise. Preserve the separate rule that an already-used Session is not disposed merely because lifecycle recovery failed.

### H-2 - Public error contract is not closed

- **Source:** addendum Architecture handoff item 7 (`addendum.md:51`), PRD FR-7 (`prd.md:133-138`), FR-21 through FR-23, and observability requirements require stable Transport/Session/SDK codes plus cause mapping. Remote ProtocolError must retain code, message, and retryability.
- **Spine:** `TransportSendError.code` references an undefined `TransportSendErrorCode` (`ARCHITECTURE-SPINE.md:289-295`), and `InputTextError` is named but its code union and Session-to-SDK mapping are absent (`:136`).
- **Required correction:** define the stable send-code union (`not-connected`, `message-too-large`, `queue-full`, `connection-ended`, `invalid-frame`, `reassembly-timeout`, `retransmission-exhausted`, `sequence-exhausted`, `internal`) and the adopted `InputTextError` codes (`input-empty`, `input-too-large`, `not-ready`, `unsupported`, `busy`, `not-delivered`, `delivery-unknown`, `response-timeout`, `remote-error`, `invalid-response`, `session-disposed`). State how `scope`, `delivery`, ProtocolError fields, and `cause` survive each mapping.

### H-3 - Heartbeat invariant is only partially represented

- **Source:** PRD FR-12 (`prd.md:183-200`) and addendum (`addendum.md:211-220`) bind one outstanding Pong, defaults of 15-second interval and 10-second Pong timeout, timeout start only after Ping delivery, run-epoch invalidation on stop, no implicit start, and asymmetric timeout recovery: Client forces a new generation while Server closes its accepted Transport.
- **Spine:** the error paragraph covers Client recovery and two Ping send-failure classes (`ARCHITECTURE-SPINE.md:324`), but omits the defaults, one-Pong limit, post-delivery timer start, explicit-start/run invalidation rules, and Server heartbeat-timeout action. A generic verification row does not fix implementation semantics.
- **Required correction:** promote the complete heartbeat lifecycle into an AD Rule or Session structural contract, including the Server composition-root close behavior.

## Medium

### M-1 - Deterministic inbound Request failure behavior did not land

- **Source:** PRD FR-12 (`prd.md:192-200`) and addendum (`addendum.md:197-207`) fix exact behavior for unregistered methods, `ProtocolRequestError`, ordinary handler exceptions, duplicate requests, and invalid messages.
- **Spine:** duplicate tombstones and diagnostic codes landed, but it never binds `method.unsupported`, verbatim structured ProtocolError mapping, non-retryable `request.failed`, or “do not reply from untrusted fields” after Codec failure.
- **Required correction:** add the small deterministic mapping table or equivalent Rule so independently-built Client/Server Session paths cannot diverge.

### M-2 - Explicit-close and lifecycle reentrancy are tests, not architecture rules

- **Source:** PRD FR-6/FR-19/FR-20 and addendum Architecture handoff item 3 require the explicit-close race to be fixed, including cancellation and immunity to late connect/reconnect callbacks.
- **Spine:** AD-9 binds epochs and Client-level joining/queuing, while the only mention of FIFO reentrancy is a verification phrase (`ARCHITECTURE-SPINE.md:523`). It does not define `ClientTransport.connect()` behavior while connected/connecting/reconnecting, `disconnect()` cancellation linearization, or lifecycle-listener reentrant commands.
- **Required correction:** bind the adopted command semantics: Transport `connect()` is idempotent when connected and joins the current single-flight while connecting/reconnecting; `disconnect()` linearizes explicit stop before cancelling socket/listeners/timers; connect during disconnect queues after cleanup; lifecycle-listener reentrant commands enter the same FIFO command queue; stale callbacks are epoch-discarded.

### M-3 - Peer dependency policy remains implicit

- **Source:** PRD FR-29 and open question 1 (`prd.md:370-377`, `:505-511`) plus addendum handoff item 1 require peer dependency ranges to be fixed before Story decomposition.
- **Spine:** AD-13 fixes package names/exports, `workspace:^`, same-major caret compatibility, and Socket.IO as a normal dependency, but does not say which internal package relationships are `dependencies` versus `peerDependencies`, or explicitly state that none are peers.
- **Required correction:** name the dependency class for every public package edge and, for each peer edge, its concrete major range. If the decision is “no internal peers,” state that directly.

## Reconciled Areas

No discrepancy found in the responsibility layers, Session message-only port, pending-before-send/first-wins timing, concurrent Request admission, response timeout range, stable receive ownership, generation-local no-replay, delivery outcome semantics, Socket.IO DATA/ACK layout and limits, four-package ownership, operation revision rules, accepted-Server asymmetry, security scope, or migration/test boundary.
