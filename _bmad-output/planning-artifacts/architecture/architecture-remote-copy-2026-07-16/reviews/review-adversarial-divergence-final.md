# Adversarial Divergence Review - Final

## Scope

- Artifact: `ARCHITECTURE-SPINE.md`
- Lens: independently implemented SDK, Session, Protocol/Codec, Socket.IO Client Transport, Socket.IO Server Transport, and Server composition
- Question: can all units obey every AD literally and still make incompatible choices?
- Reviewed source: the spine only

## Verdict

**CHANGES REQUIRED**

The package and responsibility boundaries are coherent, but five remaining contract gaps can produce observably different behavior between independently built units. Three are high severity because they can turn a recoverable connection generation into a terminal Client error, erase the `delivery-unknown` safety signal, or silently discard valid Operation updates.

| Tier | Count |
| --- | ---: |
| Critical | 0 |
| High | 3 |
| Medium | 2 |

## High Findings

### H-1 - Generation-fatal ordering leaves `session.open` recovery nondeterministic

**Evidence:** AD-6 says a generation-fatal path terminates unfinished sends and publishes lifecycle changes, but does not order those two effects (lines 98-100). AD-9 requires each connected generation to run `session.open`, names ProtocolError, invalid result, and readiness-deadline failure as terminal, and guards writes with `clientCycleId + generation` (lines 118-122). AD-12 requires generation-fatal cleanup to be atomic but likewise does not order lifecycle publication against send rejection (lines 142-144).

**Two literal implementations:**

1. Client Transport rejects the generation's unfinished `send()` promises, then writes/publishes `reconnecting`. The Session rejects the generation's `session.open` while the Client still regards that generation as current; the SDK may enter `error` and explicitly suppress recovery.
2. Client Transport writes/publishes `reconnecting`, then rejects unfinished sends. The SDK invalidates that generation first, drops the old open callback, and permits the next generation to open.

Both satisfy the current rules, but one aborts automatic recovery and the other completes it. The same ambiguity applies when an ACKed open Request later reaches Response timeout while a newer generation is opening or ready.

**Required correction:** Fix one linearization rule and the Client outcome table. At minimum:

- a generation-ending Transport must write and synchronously publish the non-connected lifecycle snapshot before settling that generation's unfinished sends;
- an open result is generation-scoped, and any result for a generation that is no longer the current connected generation has no Client state effect;
- `transport-send-failed` and `response-timeout` for an ended generation do not terminate the recovery readiness promise;
- state exactly which current-generation open failures are terminal, and whether a readiness deadline spans all generations in that recovery episode.

Add a verification case where disconnect, open send rejection, lifecycle publication, a later-generation open success, and an old Response timeout occur in every possible callback order.

### H-2 - The SDK error map skips the actual Session wrapper around Transport failure

**Evidence:** AD-12 requires Session Request rejection to use `SessionRequestError` (line 142). The type includes `code: "transport-send-failed"` with an unconstrained `cause?: unknown` (lines 320-332). The fixed SDK mapping table maps a raw `TransportSendError`, but contains no row for `SessionRequestError(transport-send-failed)` (lines 371-381).

**Two literal implementations:**

1. Session wraps a `TransportSendError` as `cause`; SDK structurally unwraps it and preserves `delivery-unknown`.
2. Session records a generic cause or SDK treats every `transport-send-failed` as `not-delivered`, because the published mapping never requires the nested shape.

The second implementation can tell callers that blind retry is safe after DATA may have left the process, violating the central delivery-finality invariant.

**Required correction:** Add the missing cross-layer rule and mapping row: `SessionRequestError(code="transport-send-failed").cause` must be the original structurally valid `TransportSendError`, and SDK must map its `delivery` field to `InputTextError.code` while preserving the whole Session error as cause. Define a deterministic fallback for a malformed/missing nested error; it must not downgrade uncertainty to `not-delivered`. Verify both delivery values through Transport -> Session -> SDK.

### H-3 - "Legal" Operation transitions are not defined, so SDK and Server can disagree

**Evidence:** AD-14 accepts only higher revisions whose state transition is "legal" (line 162). AD-16 defines the four states and only says terminal states cannot transition (lines 170-174). AD-18 lets Server advance state atomically but does not define its transition graph (lines 182-188).

**Two literal implementations:**

1. Server emits `accepted@1 -> succeeded@2` for a fast operation; SDK requires `accepted -> processing -> terminal` and drops revision 2.
2. Server emits repeated `processing` revisions to update `stage`; SDK rejects same-state transitions as illegal and keeps a stale stage.

There is also no rule for the first snapshot of an unknown Operation: after cache eviction or reconnect, the first observed state may already be `processing` or terminal.

**Required correction:** Publish one transition matrix shared by protocol producers and `OperationStore`, including same-state higher-revision stage updates and admissible initial states for an unknown cache entry. A convergent minimal matrix would explicitly decide `accepted -> accepted|processing|succeeded|failed`, `processing -> processing|succeeded|failed`, and no transition out of terminal states, while allowing any validated state as the first observed snapshot if earlier revisions may legitimately be absent. Add producer/consumer contract tests over every matrix cell.

## Medium Findings

### M-1 - Explicit-stop intent and `send()` admission are not linearized

**Evidence:** AD-6 says `send` is accepted whenever state is `connected`, while `disconnect()` synchronously records explicit-stop intent but need only publish `disconnected` before its Promise resolves (lines 98-100). The public lifecycle union has no `disconnecting` state (lines 233-263).

**Two literal implementations:**

1. A Transport keeps the connected snapshot during asynchronous teardown and accepts a new `send` because the public admission rule still holds.
2. A Transport consults a private stop flag and rejects the same call immediately.

This is visible to direct Session/Server composition and determines whether bytes submitted after explicit shutdown begin can enter the old generation.

**Required correction:** Make explicit-stop intent part of the send admission predicate: after the synchronous disconnect linearization point, every new send must reject immediately as `not-delivered` with a fixed code/scope, even if the last published snapshot is temporarily `connected`. Also fix the error and delivery classification for sends that were already queued or in flight at that point. Verify reentrant send from a lifecycle listener and send in the interval between `disconnect()` invocation and resolution.

### M-2 - Server's protocol import surface is optional while its dependency set assumes it is present

**Evidence:** AD-13 says `@remote-copy/session` *may* re-export protocol types/constants needed by Server, while Browser and Server direct-install guidance gives Server only Session and Transport, and internal dependency edges remain package-private under pnpm's strict dependency model (lines 150-156). The dependency graph likewise has no Server -> Protocol edge (lines 466-475).

**Two literal implementations:**

1. Session re-exports the handler, method, error, and Operation contracts; Server imports them from Session.
2. Session exports only its own runtime and guards, which is allowed by "may"; Server cannot legally import the Protocol definitions it needs without adding an undeclared direct dependency.

**Required correction:** Choose one exact public boundary. To preserve the confirmed two-package Server installation, make the Session re-export mandatory and enumerate the protocol symbols or export namespace guaranteed to Server integrations. Otherwise add `@remote-copy/protocol` as a direct Server dependency and require imports from `/definitions`. Add an exports test that compiles a minimal external Server composition using only the documented direct dependencies.

## Non-Findings

- No remaining incompatible choice was found in the DATA/ACK field layout, generation-local counters, chunking constants, cumulative ACK semantics, or retry limits; both Socket.IO adapters are bound to one private core.
- Session ownership of Request correlation, heartbeat run invalidation, and receive registration is sufficiently separated from Transport lifecycle ownership once H-1's ordering is fixed.
- The four-package direction is internally coherent once M-2 makes the Server-facing Protocol surface mandatory rather than optional.

## Gate Exit Criteria

The spine is ready for polish when H-1 through H-3 are fixed as explicit invariants and M-1/M-2 are either fixed or deliberately deferred with a concrete revisit condition. The verification contract should gain one test family for each correction; no further component or package split is required by this review.
