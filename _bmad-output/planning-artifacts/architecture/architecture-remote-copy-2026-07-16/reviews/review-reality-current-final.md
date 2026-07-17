# Reality / Current Technology Review

**Artifact:** `ARCHITECTURE-SPINE.md`  
**Review date:** 2026-07-17  
**Verdict:** **CHANGES REQUIRED** - the selected stack is real and compatible, but one Socket.IO isolation rule is only implied, so a conforming implementation could replay an old-generation buffered frame and violate delivery finality.

## Critical

None.

## High

### H-1 - A fresh, non-reconnecting Socket.IO instance per Connection Generation is not an enforceable invariant

**Location:** AD-8 lines 108-112; AD-9 lines 114-122; Verification Contract line 616.

**Why this matters:** The spine requires old Socket/offline-buffer data never to reappear after a failed generation, but its Rule only says Socket.IO offline buffering and recovery are not product guarantees. It does not require the mechanism that makes resurrection impossible. Socket.IO 4.x buffers ordinary client events emitted while disconnected and flushes them after reconnection. A builder can therefore reuse one `Socket` across generations, satisfy the stated public lifecycle API, and still flush an old `protocol:frame` from `sendBuffer` in a later generation. That contradicts AD-7 rejection finality and the no-cross-generation replay contract.

The current brownfield implementation happens to avoid this with a newly created Socket using `autoConnect:false`, `forceNew:true`, and `reconnection:false`, but those implementation details are not preserved by the target spine while the code is moved into a new package. Socket.IO's own `retries` and server `connectionStateRecovery` must also stay disabled for this wire.

**Evidence:**

- Socket.IO documents that disconnected-client events are buffered until reconnection: <https://socket.io/docs/v4/client-offline-behavior/>.
- Socket.IO documents ordered arrival but default at-most-once delivery, and distinguishes disconnected buffering from retry of an in-flight event: <https://socket.io/docs/v4/delivery-guarantees/>.
- Connection-state recovery must be enabled on the server and is explicitly not guaranteed to succeed: <https://socket.io/docs/v4/connection-state-recovery/>.
- Installed `socket.io-client@4.8.3` stores a normal event in `sendBuffer` when its internal connected check fails and drains that buffer in `emitBuffered()` after connect (`build/esm/socket.js:238-274`, `585-607`).

**Required action:** Amend AD-8 or AD-9 to require each Connection Generation to own a fresh Socket.IO `Socket` and Manager (`forceNew:true`), with `autoConnect:false`, Socket.IO reconnection/retries disabled, server connection-state recovery disabled for `protocol:frame`, and the old Socket permanently discarded on generation termination. Keep the existing epoch guard. Alternatively specify an equally strong, tested mechanism that proves no old `sendBuffer` entry can ever flush into a later generation.

## Medium

### M-1 - The exact Node.js stack version is observational, not reproducible

**Location:** Stack lines 205-215.

**Why this matters:** `Node.js 24.15.0` matches the review machine, and Socket.IO 4.8.3 supports it, but the repository has no `engines.node`, `.node-version`, `.nvmrc`, or equivalent toolchain pin. Two independent builders can therefore use incompatible Node versions while both claiming conformance to the spine. The wording says the versions were checked against manifest, lockfile, and runtime, which overstates the Node manifest evidence.

**Evidence:** `node --version` reports `v24.15.0`; root `package.json` pins only `packageManager: pnpm@10.0.0`; no repository Node version declaration was found. The npm metadata for `socket.io@4.8.3` requires Node `>=10.2.0`, and `socket.io-client@4.8.3` requires Node `>=10.0.0`, so Node 24.15.0 is compatible but not enforced.

**Required action:** Either add a repository Node toolchain pin plus an `engines.node` policy and keep `24.15.0` as a binding stack choice, or label the table entry as the observed verification runtime and state the supported Node range separately.

## Current-Version Verification

The following claims were independently verified and need no correction:

| Claim | Repository/runtime evidence | Current-source evidence | Result |
| --- | --- | --- | --- |
| Socket.IO client/server `4.8.3` exists and fits | `pnpm-lock.yaml` resolves both packages to `4.8.3`; current tests/imports use the 4.x APIs | npm registry reports `4.8.3` as `latest`; server requires Node `>=10.2.0`, client `>=10.0.0` | Verified |
| Socket.IO ordering | Spine relies on ordered complete event arrival beneath its own GBN layer | Official docs guarantee event ordering across low-level transport upgrades, provided events arrive | Verified |
| Default delivery is at-most-once | Spine does not treat Socket.IO emission as Transport Delivery | Official docs state default at-most-once and no retry of an interrupted in-flight event after reconnection | Verified |
| Client offline buffering exists | Existing implementation uses normal `emit`, but currently abandons each old Socket | Official docs and installed 4.8.3 source confirm buffering and later drain | Verified; H-1 must preserve isolation |
| Connection-state recovery is insufficient | Spine excludes it from product guarantees | Official docs say it is opt-in and recovery may fail | Verified |
| TypeScript `7.0.2` | manifest, lockfile, and `pnpm exec tsc --version` agree | Installed package executes successfully | Verified |
| pnpm `10.0.0` | `packageManager` and `pnpm --version` agree | Runtime is present | Verified |
| Turborepo `2.10.4` | lockfile and `pnpm exec turbo --version` agree; manifest range resolves to it | Runtime is present | Verified |
| Transport wire/default limits | Existing frame/controller constants match 28/8-byte headers, 16 KiB chunks, 8-frame window, 2 s ACK timeout, 3 retransmissions, 10 s reassembly timeout, 256 KiB message, 128 messages/4 MiB queue | These are product-level choices, not Socket.IO defaults | Verified against brownfield code |
| Session timing/default pending limit | Existing Session uses 10 s request timeout, 15 s heartbeat interval, 10 s heartbeat timeout, and 128 pending requests | These are product-level choices | Verified against brownfield code; renamed target fields are architectural migration |

## Training-Data / Unverified Assertions

No remaining claim depends solely on remembered Socket.IO behavior. All Socket.IO assertions above were checked against current official 4.x documentation, npm metadata, the installed 4.8.3 source, and the repository lockfile. Product-level target defaults that do not exist yet are decisions inherited by the spine and already have explicit verification obligations; they are not presented as third-party library defaults.
