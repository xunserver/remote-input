# Security / Operations Recheck

**Artifact:** `ARCHITECTURE-SPINE.md`  
**Review date:** 2026-07-17  
**Scope:** Recheck only M-1 and M-2 from `review-security-ops-final.md`.

## Verdict

**PASS**

## Resolution Check

### Prior M-1 - Unbounded concurrent inbound handlers

Resolved. AD-3 adds configurable `maxConcurrentHandlers` with a default of 128. Requests beyond capacity do not invoke a handler and receive the deterministic retryable `request.capacity-exhausted` response. The public options shape, inbound mapping, and Session verification contract all carry the same rule.

### Prior M-2 - Diagnostic and peer error disclosure

Resolved. The diagnostics convention limits `cause/stack` to explicit in-process development diagnostics and prohibits protocol serialization, default UI display, persistence, and automatic logging. Composition-root logs are restricted to non-payload metadata, and unexpected handler failures return only a generic `request.failed` response. This establishes the required peer/public-safe boundary while retaining opt-in local debugging context.

## Remaining Findings

None within the requested recheck scope.
