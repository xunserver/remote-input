# Reality / Current Recheck

## Verdict

**FAIL - four high-impact brownfield contract gaps remain.** The latest Spine now clearly labels most target behavior as `[NEW]`, preserves the six-state SDK `ConnectionState`, reproduces the current `RemoteInputState`, retains all existing `RemoteInputClientOptions` fields, and records the main `subscribe -> receive`, TransportError, connect, operation, Server and internal-file migrations. The remaining issues can still produce incompatible public declarations or divergent implementations.

## Findings

- AD-10 is still marked `[ADOPTED]` even though its Rule mixes the adopted identifier-layer separation with new requirements: operationId becomes a high-entropy global business key, request/heartbeat/inbound IDs become non-reusable for the whole generation, and three issued/seen sets receive a `1000000` cap. Those requirements are not in the current contract or repository constraints. Split AD-10 into an adopted namespace rule and a `[NEW]` uniqueness/resource-policy rule, then add the latter to the migration ledger.

- The two new SDK error codes have no public type owner. The ledger calls `connection-superseded` and `operation-cache-full` “Additive errors”, but neither appears in `SendInputErrorCode`, `RemoteInputErrorCode`, a new connect error class, or a defined SDK event union. AD-14 says to “publish” `operation-cache-full` without naming the channel, while AD-9 only says the old connect Promise rejects. Define the exact class/union/property for each code and its state/listener effects; otherwise implementations can expose incompatible error shapes.

- AD-12 says SDK mappings preserve `cause`, but the reproduced `RemoteInputState` still references the current `RemoteInputError`, whose public shape is only `{ code, message? }`; no target `RemoteInputError` definition adds `cause`. `SendInputError` can already carry `Error.cause`, but state errors cannot satisfy the new Rule. Either limit cause preservation to thrown Error classes or explicitly add `cause?: unknown` to `RemoteInputError` and classify that public shape change in the ledger.

- The Structural Seed silently removes `readonly transport: MessageTransport` from the existing public `ProtocolSessionContract`. This omission is not in the migration ledger and directly affects `createSession`, whose new factory must return that contract. Restore the current member or explicitly classify and justify its removal as breaking. The same public-surface pass should state whether the new `RemoteInputClientContract` is documentation-only or an additive export, and explicitly retain the currently exported `RemoteInputTransportFactory` alias.

## Cleared Checks

- `ConnectionState` and all `RemoteInputState` fields match current SDK/Client usage.
- Existing `RemoteInputClientOptions` fields remain flat; `createSession` is clearly additive.
- `MessageTransport.subscribe -> receive`, structured Transport errors, superseded connect, operation Store policy, Server-global operation semantics and SDK internal file decomposition are represented in the migration ledger.
- Existing `SendInputErrorCode` and `RemoteInputErrorCode` mappings are enumerated; only the ownership of the two newly named codes and `cause` remains unresolved.
