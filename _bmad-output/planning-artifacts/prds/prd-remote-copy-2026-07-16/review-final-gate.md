# Final Semantic Gate - Client / Session / Transport PRD

- **Review date:** 2026-07-17
- **PRD:** `prd.md`
- **Technical addendum:** `addendum.md`
- **Review mode:** read-only semantic acceptance
- **Scope:** latest confirmed lifecycle rules, FR continuity, failure semantics, heartbeat, accepted Server Transport, Socket.IO wire invariants, assumptions and open questions

## Verdict

**READY FOR POLISH.** The candidate PRD has no Critical or High semantic finding. The two latest user confirmations are now normative, testable, and consistent across the PRD and technical addendum. The remaining assumption and open questions are bounded Architecture handoffs; none reopens the layer ownership, connection-generation, delivery-finality, or application-readiness decisions.

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 1 |

## Confirmed Decision Acceptance

### 1. Ended generations never replay unfinished sends - PASS

- FR-19 prohibits an unfinished `send` from continuing on a new lower-level connection (`prd.md:265`).
- FR-27 terminates every unfinished old-generation send, classifies it as `not-delivered` or `delivery-unknown`, and requires the new generation to serve only newly submitted messages (`prd.md:337-346`).
- The same boundary is explicitly out of scope under MVP exclusions (`prd.md:474-479`) and is repeated as a risk guardrail (`prd.md:498-505`).
- The addendum resets wire state for every generation and expressly rejects cross-Socket replay (`addendum.md:284-295`).

This is compatible with the current wire protocol: no logical connection identity, resume handshake, cross-connection ACK state, or Server retention is implied.

### 2. New sends during `connecting` / `reconnecting` fail immediately - PASS

- FR-19 says such calls do not enter the queue and immediately fail as `not-delivered` (`prd.md:253-265`).
- The addendum admission table covers pre-connect, connecting, connected, reconnecting, explicitly disconnected, and recovery-exhausted states (`addendum.md:271-282`).
- Client application calls are independently gated as `not-ready`, so they cannot place business Requests ahead of `session.open`; direct Session callers still receive Transport's authoritative admission result.

There is one queue owner only: the Transport queue exists for calls admitted during a connected generation, while Session does not add a recovery queue.

### 3. Active Client Transport recovery is bounded to 3 attempts / 30 seconds - PASS

- FR-19 assigns automatic recovery exclusively to an active Client Transport after an established connection unexpectedly ends or becomes connection-fatal (`prd.md:253-263`).
- The default is at most three reconnect attempts within a total 30-second recovery budget; exhaustion enters observable `error` and stops background recovery until an explicit `connect()`.
- Explicit `disconnect()` cancels attempts and timers and suppresses recovery until a later explicit connect (`prd.md:260-263`, `prd.md:120-127`).
- The addendum preserves the same state/admission matrix (`addendum.md:271-282`).

The exact backoff curve remains an Architecture concern without changing the bounded product behavior.

### 4. `session.open` and Client ready gate - PASS

- Transport `connected` is explicitly distinct from Client application `ready` (`prd.md:107-118`).
- `client.connect()` resolves only after `session.open` succeeds for the current generation and ready is set (`prd.md:109-115`).
- Every new generation performs exactly one generation-keyed open; old-generation results cannot mark the new generation ready (`prd.md:116-118`, `prd.md:267-276`).
- Client clears ready and stops heartbeat immediately when Transport leaves connected; business APIs fail `not-ready` until the new generation opens (`prd.md:116-118`, `prd.md:260-265`).
- Open failure has a finite result and preserves later explicit reconnect capability (`prd.md:113-115`).

This closes the ordering invariant:

```text
connected(generation N)
  -> session.open for N
  -> heartbeat start
  -> Client ready
  -> business Request admission
```

## Cross-Cutting Acceptance

### FR continuity and testability - PASS

- Mechanical extraction yields exactly one continuous sequence from FR-1 through FR-32, with no gap or duplicate.
- FRs are grouped by Client, Session, Transport, Socket.IO implementation, and package/migration boundary.
- The validation threshold maps protocol, Transport, SDK, and Server test suites to the relevant behavior and preserves the safety rule that automated real integration only sends `session.open` (`prd.md:441-448`).

### Failure finality - PASS

- The glossary distinguishes `not-delivered` from `delivery-unknown` (`prd.md:48-64`).
- FR-21 correctly defines rejection as local Promise/transmission finality, not proof of remote non-receipt (`prd.md:278-286`).
- Connection-fatal cleanup classifies admitted-but-unemitted messages conservatively and releases queues, windows, reassembly state, and timers (`prd.md:288-296`).
- NFRs, success metric SM-3, and risk guardrails use the same local-finality language (`prd.md:399-415`, `prd.md:481-505`).
- The addendum explicitly covers lost final ACK and disables Socket.IO offline-buffer resurrection (`addendum.md:234-258`, `addendum.md:306-318`).

No remaining text claims that a rejected send proves the peer did not receive or process the message.

### Session and heartbeat ownership - PASS

- Session depends only on complete-message `send` and `receive`; it neither reads Transport state nor invokes lifecycle APIs (`prd.md:201-212`).
- Receive registration survives internal Transport generation changes and delivered bytes have stable ownership (`prd.md:207-223`).
- Session owns Ping/Pong correlation and timers, starts no heartbeat implicitly, and waits for Ping delivery before starting Pong timeout (`prd.md:178-190`).
- Client starts heartbeat only after the current generation opens and stops it when that generation leaves connected. A heartbeat timeout is emitted upward; Client/Server composition roots, not Session, perform lifecycle action (`prd.md:185-190`).
- Run-epoch invalidation prevents old callbacks, timers, and Pong messages from affecting a new generation (`prd.md:187-189`).

### Active Client vs accepted Server Transport - PASS

- FR-20 requires active connect only for Client Managed Transport and gives accepted Server Transport state, close, and observation without requiring `connect()` (`prd.md:267-276`).
- FR-28 says a closed accepted Socket is not recovered; a later Client Socket creates a new Server Transport/Session composition (`prd.md:348-356`).
- The addendum's capability split models `ClientManagedTransport` as the only interface with `connect()` (`addendum.md:41-68`) and repeats the asymmetric lifecycle (`addendum.md:297-304`).

### Socket.IO wire constraints - PASS

The addendum retains all repository interoperability invariants:

- one binary `protocol:frame` event and no business JSON parsing (`addendum.md:306-318`);
- 28-byte big-endian DATA header with the required field order (`addendum.md:320-335`);
- fixed 8-byte cumulative ACK that bypasses the DATA window and is never ACKed (`addendum.md:337-348`);
- independent per-direction generation counters starting at zero, no wrap, DATA `frameSeq <= 0xfffffffe`, and `0xffffffff` reserved for final cumulative ACK (`addendum.md:350-353`);
- 16 KiB chunks, eight-frame window, two-second ACK deadline, three retransmission rounds, ten-second no-progress reassembly deadline, 256 KiB message limit, 128-message / 4 MiB queue limit (`addendum.md:354-360`);
- mandatory cross-message Go-Back-N window, cumulative-progress timer reset, exact-next-frame receive rule, complete-only delivery, and illegal-frame rejection (`addendum.md:362-371`);
- `send()` resolves only after cumulative Transport ACK covers the entire message (`addendum.md:234-240`).

These constraints agree with FR-15 through FR-28 and preserve the Codec/Session boundary.

## Remaining Findings

### Medium - Architecture must close deferred public contract names before Story decomposition

The PRD intentionally leaves package/export layout, exact lifecycle state/event types, Session disposal method name, and Client state/Notification subscription names to Architecture (`prd.md:507-513`). This does not block PRD polish or Architecture work, but implementation stories must not begin until Architecture freezes them. The addendum already supplies the behavioral constraints those names must preserve (`addendum.md:41-76`, `addendum.md:430-439`).

**Disposition:** defer to `bmad-architecture`; retain as an explicit pre-Story gate.

### Low - Confirmed disconnect semantics are still introduced as "suggested" in the addendum

`addendum.md:128-135` labels explicit-close behavior as `建议语义`, although FR-6 and the memlog record it as confirmed. The listed behavior itself is correct and does not conflict with the PRD, but the heading weakens its normative status.

**Disposition:** polish wording to `已确认语义`; no semantic redesign required.

## Assumption and Open-Question Audit

### Assumption

Only one `[ASSUMPTION]` remains: the public Session Response-timeout configuration range of 1 to 120 seconds (`prd.md:158-167`, `prd.md:515-519`). The 10-second default, finite-positive validation, timer start after Transport Delivery, and early-Response race behavior are already normative. The provisional range is therefore non-blocking for Architecture, but must be confirmed before its constructor tests are written.

### Open questions

The three open-question groups are:

1. package names, physical ownership, exports, and peer dependency ranges;
2. exact Transport lifecycle/state and Session disposal API names;
3. exact Client state and Notification subscription API names.

All are assigned to Architecture and explicitly required before Story decomposition (`prd.md:507-513`). None changes the accepted ownership or state-machine semantics. The addendum's Architecture handoff list adds backoff shape, error-code mapping, and test-matrix decomposition; these are downstream design tasks, not unresolved product decisions (`addendum.md:430-439`).

## Final Gate Conditions

The PRD may proceed to structural/prose polish and finalization provided that polish:

- does not weaken the confirmed old-generation no-replay rule;
- preserves immediate `not-delivered` admission failure outside a connected generation;
- preserves the three-attempt / 30-second automatic recovery budget and explicit-connect restart rule;
- preserves generation-keyed `session.open` before ready and heartbeat;
- leaves the remaining Architecture handoffs visible until they are frozen.

