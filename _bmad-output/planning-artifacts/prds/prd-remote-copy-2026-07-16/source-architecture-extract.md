# Architecture Source Extract - Session + Socket.IO Transport PRD

## Source

- Source artifact: `architecture/architecture-remote-copy-2026-07-16/ARCHITECTURE-SPINE.md`
- Source status: `final`
- Extraction scope: `ProtocolSession` and Socket.IO Client/Server `MessageTransport`, including only the SDK/Server integration outcomes needed to define those components.
- Extraction rule: product capability, observable behavior, scope and acceptance belong in `prd.md`; algorithms, wire details, exact class/file structure and migration mechanics belong in `addendum.md`.

## PRD-Eligible Product Intent

### Problem / Outcome

The browser SDK and Server need one interoperable session and transport substrate that prevents protocol correlation and link reliability concerns from leaking into application code. Application-facing components should be able to exchange typed requests, responses and notifications over Socket.IO as reliable, ordered, bounded complete messages, without knowing about frames, ACKs, retries or Socket.IO events.

Expected outcomes:

1. Concurrent calls cannot complete with another request's response, leak after disconnect, or be reversed by a late send failure.
2. Client and Server see the same complete message boundaries and ordering despite fragmentation, retransmission, duplicate frames or ACK loss.
3. Notifications, inbound request handlers and heartbeat remain independent from normal Request/Response correlation.
4. Connection replacement, explicit close and fatal link failure produce deterministic cleanup and observable terminal states on both ends.
5. SDK and Server depend on the same protocol contracts and standard implementations rather than parsing or constructing protocol envelopes themselves.

Source: Design Paradigm; AD-1, AD-3, AD-4, AD-7, AD-9, AD-11, AD-12.

## PRD-Eligible Capabilities

### CAP-1 - Complete-Message Transport Contract

The component set exposes a common Transport surface with connection, disconnection, sending, receiving and current-state capabilities. Sending accepts one complete byte message; receiving publishes only complete byte messages plus lifecycle/error events. The Transport hides link framing and never exposes business protocol objects or raw Socket.IO frames.

PRD-visible contract outcomes:

- Reliable, ordered, bidirectional delivery that preserves message boundaries.
- A send completes only after the peer Transport has confirmed the entire message, not when the remote application has processed it.
- Multiple queued messages may progress efficiently without adding a public batch API or changing per-message completion semantics.
- Client and Server implementations expose the same observable contract.

Source: AD-1, AD-6, AD-7, AD-8.

### CAP-2 - Generic Protocol Session

The Session accepts typed `method + body` calls and provides typed success results, incoming request handlers, one-way notifications and heartbeat. It remains independent of `inputText`, operation execution and concrete Transport type.

PRD-visible contract outcomes:

- Every request receives a unique short-lived correlation identity.
- Concurrent requests resolve or reject only from their matching response/failure.
- Success results are runtime-validated against the original method before reaching callers.
- Unsupported, duplicate, unknown or late protocol interactions are reported without being matched to another request.
- Client and Server use the same Session contract in opposite roles.

Source: AD-3, AD-4, AD-5, AD-10, AD-11.

### CAP-3 - Session Lifecycle And Health

The Session can establish and close its Transport dependency, publish high-level lifecycle/errors, manage heartbeat, and release all unfinished work when the connection ends or is replaced.

PRD-visible contract outcomes:

- Explicit disconnect is idempotent.
- A later connection attempt supersedes stale asynchronous work; stale events cannot mutate the current connection.
- A normal close ends as disconnected; a reliability or protocol-link fatal ends as error.
- Pending requests and heartbeat work never remain live after either terminal path.
- Initial connection failure and established-link failure remain distinguishable to integrators.

Source: AD-9, AD-12; Transport and SDK state models.

### CAP-4 - Reliable Socket.IO Pair

The standard package supplies interoperable Socket.IO Client and Server Transport implementations that carry complete protocol messages through one binary Socket.IO channel and recover from recoverable loss without upper-layer involvement.

PRD-visible contract outcomes:

- Large messages are transparently split and restored.
- Recoverable missing/duplicate data or acknowledgements do not duplicate upper-layer delivery.
- Exhausted delivery, malformed link data and stalled reassembly terminate consistently and release resources.
- Bounded message and queue capacity rejects excess work predictably without destabilizing a healthy connection when the failure is call-local.

Source: AD-7, AD-8, AD-12; Transport Pipeline and Error/Cleanup Matrix.

### CAP-5 - Integration And Migration Compatibility

Definitions remain the sole public contract source; standard runtime implementations remain explicit imports. The Session/Transport change is delivered atomically across Client, Server, SDK, test doubles, exports and documentation so consumers never need to probe for two competing receive APIs.

Source: AD-6, AD-11, AD-13; Brownfield Migration Ledger.

## PRD-Eligible Functional Requirements Seed

These are capability-level seeds, not final numbering for `prd.md`:

- The system shall let a caller connect and disconnect a MessageTransport and synchronously inspect its current lifecycle state.
- The system shall let a Session subscribe to Transport events before connection establishment and receive subsequent complete-message, state and structured-error events.
- The system shall send a complete byte message while preserving order and message boundaries relative to every other send on the connection.
- The system shall support concurrent typed Session requests and complete each request exactly once from its matching response, send failure, timeout or connection termination.
- The system shall validate inbound protocol envelopes and method-specific request, notification and successful result bodies before exposing typed values.
- The system shall let either peer register typed request handlers, emit notifications and answer heartbeat probes without application-managed correlation.
- The system shall reject and clear all unfinished sends and Session requests after fatal failure or disconnect.
- The Socket.IO Client and Server pair shall interoperate under message fragmentation, lost data, lost acknowledgement, duplicate delivery attempts and bidirectional traffic.
- The system shall enforce bounded message, queue and pending-request resources and distinguish call-local capacity rejection from connection-fatal failure.
- The migration shall replace the former Transport subscription method across all in-repository implementations and consumers without retaining runtime dual-interface fallback.

## PRD-Eligible Non-Goals

1. No Bluetooth, GATT or MTU implementation or simulation in this release.
2. No additional WebSocket or generic unreliable-link Transport.
3. No automatic reconnect, backoff or Session resume.
4. No new Codec, protocol version negotiation, authentication or end-to-end encryption.
5. No new service, database, persistence layer or deployment topology.
6. No public `sendBatch()` and no exposure of Transport DATA/ACK frames to Session or SDK.
7. No input execution, clipboard/paste behavior, React UI state, input history or product-specific operation cache inside Session or Transport.
8. No change to the meaning of Transport acknowledgement: it does not replace a protocol Response or indicate business-operation completion.

Source: AD-1, AD-3, AD-7, AD-15; Deferred.

## PRD-Eligible Success Conditions

### Behavioral Acceptance

- Concurrent responses correlate to the correct request under reordered completion.
- An early response remains valid even if local Transport send confirmation arrives later; a later send failure cannot reverse an already completed request.
- Timeout starts only after Transport confirms complete-message delivery.
- Disconnect, connection replacement and fatal failure reject all unfinished requests/sends and leave no active heartbeat or retransmission work.
- Normal close ends as disconnected; fatal link failure ends as error, consistently for Client and Server.
- Notifications and inbound handlers work bidirectionally; Ping/Pong uses an independent identity and does not consume request correlation slots.
- The Transport pair preserves complete-message order and delivers each reconstructed message at most once per connection under the tested loss/duplicate scenarios.
- Oversized messages and full queues reject only the affected call; malformed frames, stalled reassembly, retry exhaustion and sequence exhaustion terminate the connection.

### Compatibility Acceptance

- Definitions, implementations, SDK, Server and test doubles compile against one `receive`-based Transport contract with no `subscribe` fallback.
- Root/definitions exports contain contracts and constants only; implementations exports contain runtime validation, Codec, Session and Transport implementations.
- Existing public state and base SDK error meanings remain stable except for explicitly documented additive/breaking changes.

### Verification Acceptance

- Required automated coverage exists for Codec/messages, Session, Transport, SDK integration and Server integration as listed in the architecture Verification Contract.
- `pnpm test:protocol`, `pnpm test:sdk`, `pnpm test:server`, `pnpm check` and `pnpm build` pass.
- Real integration verification performs only `session.open`; it never sends a non-empty `input.submit`.
- Public contract changes are reflected in package exports and the root, Protocol and SDK Chinese READMEs.

## PRD-Eligible Constraints

- Current runtime topology remains Browser Client to one Node Server Socket.IO endpoint; the Server also hosts static assets.
- Socket.IO Client and Server must be deployed with compatible Transport framing configuration; this release does not negotiate configuration online.
- A Session owns one Transport instance; two Sessions must not consume the same receive stream.
- Application protocol and link-transport identifiers remain separate; Transport must not inspect requestId, heartbeatId or operationId.
- Resource use must be explicitly bounded for pending Session calls and queued/partially transmitted Transport messages.

## PRD Open / Deferred Items

No unresolved item blocks the Session + Socket.IO Transport release described by the final architecture. Future product decisions that should remain visible as deferred, not silently inferred, are:

1. Whether a later release adds automatic reconnect, backoff or Session resume; revisit only after cross-connection product semantics are defined.
2. Whether a later release adds Bluetooth Transport; its GATT/MTU/reliability design belongs to that release.
3. Whether protocol negotiation, authentication or end-to-end encryption becomes required for additional deployment environments.
4. Whether another Codec is needed for interoperability.

The optional directory subdivision under `implementations/` is not a PRD question; it is an implementation choice for the addendum.

## Addendum-Only Technical Mechanisms

The following source material should not be promoted into the PRD's main capability narrative.

### Session Mechanisms

- Exact pending Map shape, generation fields, timer storage and first-terminal-signal algorithm.
- Register-before-send sequence and the precise handling of response-before-send-resolution.
- Response timeout starting after Transport ACK.
- Per-generation issued/seen ID sets, the `1000000` caps, duplicate inbound request response code and reconnect reset behavior.
- Exact runtime-validation split between Codec envelope validation and Session method-specific result validation.
- Heartbeat ID tracking, timer order and generation cancellation mechanics.

### Transport API Mechanics

- Exact TypeScript interfaces and discriminated unions for `TransportState`, `TransportEvent` and `TransportError`.
- `receive()` registration synchrony, no-replay rule, listener snapshot order, unsubscribe behavior, exception isolation and lifecycle reentrancy FIFO queue.
- Event-before-Promise-settlement ordering and the precise fatal state/error lifecycle batch.
- Byte-buffer snapshot/copy requirements.

### Socket.IO Wire And Reliability Mechanisms

- The single `protocol:frame` event name.
- DATA 28-byte and ACK 8-byte binary layouts, magic/version/kind fields and network byte order.
- `frameSeq`, `messageId`, `chunkIndex`, `chunkCount`, total/payload byte fields and exhaustion rules.
- Go-Back-N algorithm, cumulative ACK upper-bound semantics, ACK bypass, retry timer reset conditions and duplicate/out-of-order handling.
- Canonical zero-byte and multi-chunk formulas.
- Exact defaults: 16 KiB payload, 8-frame window, 2-second ACK timeout, three retransmission rounds, 10-second no-progress timeout, 256 KiB message, 128 queued messages and 4 MiB queued bytes.
- Exact fatal classification for malformed frames, contradictory metadata, future ACKs, retry exhaustion, reassembly timeout and sequence exhaustion.

### Code Organization And Migration Mechanics

- Concrete class/file names, package directory tree and composition-root layout.
- The full Brownfield Migration Ledger and implementation ordering.
- Exact SDK error classes/codes and source-to-code mapping table, except where a public compatibility requirement references them.
- Atomic critical sections and subscriber data structures in Server operation handling; these belong to adjacent SDK/Server implementation addenda, not this component PRD.
- OperationStore eviction, revision transitions, tombstones and Server operationId hashing are outside this Session + Transport component PRD.

## Boundary Notes For PRD Assembly

- Mention SDK `sendInput` only as an integration example proving that Session remains method-agnostic; do not turn SDK operation management into a Session feature.
- Mention Server handlers only as the peer integration role; do not include clipboard/input execution as a component requirement.
- State reliability outcomes in the PRD, but move every field size, timer value and retransmission algorithm to `addendum.md` unless it is used as a measurable acceptance threshold.
- Preserve the architecture's distinction between Transport delivery, protocol Response and business completion in user-facing requirement language.
