# Reviewer Gate - Rubric Walker (Final)

## Verdict

**NEEDS REVISION BEFORE FINAL.** The layering, ownership, wire contract, recovery policy, package split, brownfield migration direction, and trusted-LAN operational envelope are substantially converged, but two public error/state boundaries still permit observably incompatible SDK implementations. Three medium issues should be resolved while applying those fixes.

## Deterministic Pass

`lint_spine.py` reports `ok: true` with zero mechanical findings: no placeholders, duplicate AD IDs, missing `Binds`/`Prevents`/`Rule`, or unpinned stack versions.

## High Findings

### [HIGH] R-1 - The SDK cannot deterministically recover Transport delivery outcome through the Session error boundary

**Evidence**

- AD-12 says every Session request failure uses `SessionRequestError`.
- `SessionRequestError.code` includes `transport-send-failed`, so a Transport rejection is necessarily wrapped at the Session boundary.
- The InputText mapping table nevertheless maps a raw `TransportSendError` directly and contains no row for `SessionRequestError(transport-send-failed)`.
- `InputTextError` is required to distinguish `not-delivered` from `delivery-unknown`, an FR-21/FR-31 and cross-functional observability requirement.

**Why this remains a divergence**

One SDK implementation can inspect `SessionRequestError.cause` with `isTransportSendError()` and preserve `delivery`; another can treat the wrapper as a generic Session failure or map all transport failures to `not-delivered`. Both follow different portions of the current text. That changes whether callers are warned about possible remote execution and whether retry is safe.

**Disposition: autofix before final**

Replace the raw Transport row with an explicit rule for `SessionRequestError { code: "transport-send-failed", cause: TransportSendError }`: require a structural guard, map `cause.delivery` exactly, and preserve the complete wrapper/cause chain. Also fix the fallback when the cause is malformed or absent, preferably `delivery-unknown` or `invalid-response` as an explicitly chosen conservative result. Add this case to the SDK verification row.

### [HIGH] R-2 - The public Client state and connection-error contract is referenced but not defined

**Evidence**

- The seed freezes `ClientConnectionState`, `getState(): RemoteInputState`, `subscribeState(RemoteInputStateListener)`, and several paths that enter Client `error`.
- It never defines `RemoteInputState`, `RemoteInputStateListener`, the error carried by an `error` snapshot, or the stable rejection shape of `client.connect()`.
- FR-4/FR-5 and cross-functional requirement 5.4 require callers to distinguish initial connection failure, recovery exhaustion, `session.open` failure, heartbeat timeout, and protocol validation failure.
- The brownfield SDK currently exports a materially different six-value `ConnectionState` and `RemoteInputState` containing `RemoteInputError`; the atomic migration list mentions the new state names but does not specify how the existing public fields and error types migrate.

**Why this remains a divergence**

SDK and Browser stories can independently choose different snapshot shapes, lose existing fields, expose raw Transport/Session errors, or collapse all terminal causes into one code while still satisfying the state-name list. This is both a PRD capability gap and a brownfield public-API gap.

**Disposition: discuss only if a product choice is still open; otherwise autofix**

Freeze the complete immutable `RemoteInputState` and listener types, including whether existing fields remain or are intentionally removed. Define stable Client lifecycle error codes and their mapping from Transport connect/recovery errors, `session.open` failures, readiness deadline, heartbeat timeout, and explicit cancellation. State whether `connect()` rejects with the same structured error stored in state. Record all breaking public type changes in the migration order and add exact SDK verification cases.

## Medium Findings

### [MEDIUM] R-3 - `operation-cache-full` has no observable owner or delivery channel

AD-14 requires the SDK to “publish `operation-cache-full`”, but the code is absent from `InputTextErrorCode`, no SDK diagnostic subscription is defined, protocol Notification names are closed, and `RemoteInputState` is undefined. Implementers can silently drop the update, throw from notification processing, or invent incompatible public events.

**Disposition: autofix.** Choose exactly one owner and channel. If it is a Client diagnostic/state error, add it to that public contract and specify whether it affects connection readiness; if it is intentionally internal, replace “publish” with a deterministic silent/drop rule plus logging policy. Add a cache-capacity verification case.

### [MEDIUM] R-4 - The Capability Map understates the governing decisions for FR-31 and the operational envelope

The `FR-29 to FR-32` row omits AD-14 even though AD-14 owns the FR-31 Operation cache/query/subscription behavior. AD-15 owns deployment/security scope but appears in neither the map nor the Verification Contract. The AD `Binds` fields are more accurate than the map, so a downstream planner using the map alone can miss OperationStore work and the “trusted local/LAN only” release guard.

**Disposition: autofix.** Split the last row at least into FR-29/30/32 publishing-migration and FR-31 Operation semantics, and add an operational/environment row governed by AD-15 with a release/configuration proof that no document or default claims public-internet readiness.

### [MEDIUM] R-5 - The build substrate contains avoidable seed duplication that can drift from its own ADs and the PRD

At 631 lines, the spine repeats full public declarations, the complete wire layout and limits, source ownership, a seven-step migration plan, and a broad test plan after already encoding the same calls in 18 ADs. Some seed is warranted because exact public contracts and wire interoperability are load-bearing, but the repeated error mapping has already drifted from AD-12 (R-1), demonstrating the maintenance risk the lean-spine rule is meant to avoid.

**Disposition: autofix during polish.** Keep exact type shapes and interoperable wire constants that independent packages must share. Remove narrative repetition and implementation-order detail that can be read from the PRD/implementation plan, or replace it with concise references. Ensure every surviving fact has one normative home in the spine.

## Rubric Summary

| Dimension | Result | Assessment |
| --- | --- | --- |
| Real divergence points | Partial | Core layer, lifecycle, wire, package, idempotency, and state ownership calls are fixed; Client state/error output remains open. |
| AD enforceability | Partial | Most rules are testable; AD-12 and its mapping table conflict at the Session-to-SDK boundary. |
| Feature-altitude breadth | Pass with fixes | Application, protocol, transport, composition, publishing, migration, verification, and runtime scope are all represented. |
| PRD capability coverage | Partial | FR-1 through FR-32 are cited, but FR-31 mapping and Client observability types are incomplete. |
| Deferred safety | Pass | Deferred transports, resume, wire evolution, distributed persistence, public deployment, and release tooling have explicit revisit triggers and do not reopen current delivery semantics. |
| Brownfield honesty | Partial | Current stack and atomic migration are acknowledged; the existing SDK state/error public surface is not fully reconciled. |
| Operational/environmental envelope | Pass with map fix | Single Browser-to-Node topology, static hosting, no new infrastructure, trusted local/LAN assumption, and public exposure review trigger are explicit. |
| Named technology/version fit | Pass | Stack versions match the manifest, lockfile, and runtime snapshot; Socket.IO 4.x features that are intentionally disabled are named. |
| Seed economy | Partial | Exact interoperable contracts are justified, but repetition is already producing normative drift. |

## Gate Decision

Resolve R-1 and R-2 before setting `status: final`. R-3 and R-4 are small contract/map fixes that should land in the same revision; R-5 should be handled in the final polish without weakening the exact public and wire invariants.
