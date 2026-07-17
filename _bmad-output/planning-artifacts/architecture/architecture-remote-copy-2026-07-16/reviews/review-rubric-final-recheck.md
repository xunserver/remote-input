# Reviewer Gate - Rubric Final Recheck

## Verdict

**NEEDS REVISION.** R-1, R-3, and R-4 are closed. R-2 is substantially resolved but retains one public error-union contradiction and one missing public listener alias. R-5 remains for structural polish.

## Prior Findings

| Finding | Status | Recheck |
| --- | --- | --- |
| R-1 Session-to-SDK delivery outcome mapping | CLOSED | The mapping now starts from `SessionRequestError(transport-send-failed)`, structurally recovers its `TransportSendError` cause, maps `delivery` exactly, and preserves the wrapper/cause chain. |
| R-2 Client state and connection-error contract | PARTIAL | `RemoteInputState`, `ClientConnectError`, `ClientDiagnosticError`, source mappings, and connect rejection semantics are now defined; see unresolved R2-A/R2-B below. |
| R-3 `operation-cache-full` owner/channel | CLOSED | AD-14 routes it through `subscribeState`; `ClientDiagnosticError` owns the code. Because `connectionState` is a separate field, it need not force loss of readiness. |
| R-4 Capability/operational map | CLOSED | FR-31 now maps to AD-14/AD-16/AD-18, publishing is separated, and AD-15 has an explicit operational/security row. |
| R-5 seed duplication | OPEN | The document grew from 631 to 678 lines; normative contracts were added correctly, but no deduplication/polish has occurred. |

## Unresolved Findings

### [HIGH] R2-A - `connect-cancelled` cannot be represented by the mandated state diagnostic

The mapping text says explicit disconnect cancellation rejects with `ClientConnectError(code="connect-cancelled")` and that the same cause is also written to `RemoteInputState.error` as the corresponding `ClientDiagnosticError`. `ClientDiagnosticError.code` does not include `connect-cancelled`.

This makes the declared union and mandatory behavior mutually unsatisfiable. Implementers must either omit the state error, invent a different diagnostic code, or widen the public type independently.

**Required fix:** either add `connect-cancelled` to `ClientDiagnosticError.code`, or explicitly state that caller-requested cancellation rejects the in-flight readiness Promise but does not populate `RemoteInputState.error`. The latter is cleaner for an intentional disconnect.

### [MEDIUM] R2-B - The frozen Client API references an undefined public listener type

`subscribeState(listener: RemoteInputStateListener)` is now the named public API, but `RemoteInputStateListener` still has no definition in the seed. The existing brownfield alias is `(state: RemoteInputState) => void`, so this is a small but direct public-surface omission.

**Required fix:** add `export type RemoteInputStateListener = (state: RemoteInputState) => void;` (and ensure the other referenced listener aliases have a single owning package or are already defined in protocol definitions).

### [MEDIUM] R-5 - Structural Seed remains materially duplicated

The exact public types added for R-2 are justified and should remain. The full wire restatement, source tree, seven-step migration order, and broad verification narrative still repeat the ADs and source PRD, leaving multiple normative homes. The prior mapping drift demonstrates that this is a maintenance risk, not merely prose style.

**Required fix during final polish:** retain exact public/error types and interoperable wire constants; collapse repeated narrative and implementation-order material into concise references or one normative location.

## Recheck Decision

Fix R2-A and R2-B before final status. R-5 can then be closed in the required render/polish step without reopening architectural decisions. Mechanical lint remains clean with zero findings.
