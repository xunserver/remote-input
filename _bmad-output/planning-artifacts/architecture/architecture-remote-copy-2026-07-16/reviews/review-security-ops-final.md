# Security / Operations Spot-Check

**Artifact:** `ARCHITECTURE-SPINE.md`  
**Review date:** 2026-07-17  
**Verdict:** **CHANGES REQUIRED** - the deployment guard and destructive-test guard are sound, but Session admission and diagnostic disclosure remain unbounded/underspecified.

## Critical

None.

## High

None.

## Medium

### M-1 - Unique inbound Requests can create unbounded concurrent handler work

**Location:** AD-3, AD-10, Inbound Request Mapping, Verification Contract / Session.

**Issue:** Outbound Pending requests are capped at 128 and duplicate inbound Request tombstones are bounded, but there is no cap on *active unique inbound Requests*. `handleRequest` permits asynchronous handlers, so a peer can submit many distinct request IDs before earlier handlers settle. A conforming Session may create an unbounded number of Promises, handler closures, response work items, and downstream calls even though Transport bytes and queues are bounded. Dispose invalidates late callbacks but does not prevent the allocation burst.

**Required action:** Add a per-Session `maxActiveInboundRequests` default and deterministic overload behavior that does not invoke the handler (for example a validated, non-retryable or explicitly retryable `request.capacity` Response). Require decrement on every handler terminal path and tests for flooding, dispose, and late completion. Keep this independent from outbound `maxPendingRequests` and the duplicate tombstone limit.

### M-2 - Remote error messages and public diagnostic causes lack a redaction boundary

**Location:** AD-12, Consistency Conventions / Errors, Error Contracts, Inbound Request Mapping.

**Issue:** The spine requires cause chains to be preserved and exposes diagnostics through public subscriptions/state. It also says an arbitrary handler exception becomes `request.failed`, but does not require a generic peer-safe message. A conforming implementation can therefore send raw exception messages to the remote peer or surface nested Socket.IO/OS errors containing paths, endpoint details, clipboard contents, tokens, or other sensitive context to UI/log consumers. The rule that SDK callers do not receive a raw Socket.IO error is insufficient because the same cause is placed in a public diagnostic object.

**Required action:** Define two disclosure classes: peer/public-safe errors contain only stable code plus sanitized message and non-sensitive identifiers; full causes remain local diagnostic data and must be redacted before logging or crossing a public API. Require unexpected handler failures to return a fixed generic `request.failed` message, never `error.message`, and add tests with sentinel secrets in nested causes.

## Checked And Sufficient

- **Trusted LAN / public exposure:** AD-15 clearly states that the current deployment is not a public security boundary, and Deferred requires a new review of TLS, authentication, Origin allowlisting, rate limiting, and audit before public exposure.
- **OS side effects in automation:** Atomic Migration Order and the repository verification contract restrict real Socket.IO integration tests to `session.open`; non-empty `input.submit` is prohibited and success paths use fake/message-only handlers detached from the OS executor.
- **Bounded retained resources and cleanup:** Complete messages, Transport send queues/windows, outbound Pending requests, heartbeat timers, receiver/listener ownership, Operation snapshots/tombstones, generation-fatal cleanup, and Session dispose all have explicit limits or deterministic release rules. M-1 is the remaining active-work admission gap.
