# Reviewer Gate - Reality / Current

## Verdict

**FAIL - needs explicit brownfield delta labeling before implementation.** Stack versions and named runtime technologies are grounded in the current repository: TypeScript `7.0.2`, Turbo `2.10.4` and Socket.IO client/server `4.8.3` resolve from `pnpm-lock.yaml`; pnpm `10.0.0` is both the root `packageManager` and current runtime; Node `24.15.0` is the current verification runtime. The blocking issue is that several new or behavior-changing contracts are presented beside current facts without an adopted/new marker or a complete migration contract.

## Findings

- AD-6, AD-9, AD-12, AD-14 and AD-18 have no status marker although each contains at least one new or incompatible rule. This is materially different from adjacent headings explicitly marked `[ADOPTED]` and makes a reader unable to distinguish verified current behavior from approved target behavior. At minimum, split mixed rules into `[CURRENT-VERIFIED]` and `[NEW-ADOPTED]` decisions rather than assigning one unlabeled paragraph both roles.

- AD-6's `subscribe -> receive` change is not current reality. `MessageTransport`, both Socket.IO transports, `ProtocolSession`, SDK memory transports, `packages/protocol/README.md`, `packages/sdk/README.md` and `docs/architecture.md` all use `subscribe`. The prose calls it a migration but the heading and Structural Seed present `receive` as if already established. It must be marked `[NEW-ADOPTED]` and treated as a public breaking delta with an exact affected-file and release/version strategy.

- AD-9 changes two verified lifecycle behaviors without identifying either change. Current `RemoteInputClient.connect()` silently returns after its generation is superseded, and the SDK test awaits that old call successfully; the Spine requires rejecting it. Current `SocketIoClientTransport.connect()` always starts a new generation and cancels the previous call; the Spine says a connecting Transport reuses one in-flight Promise. These are two separate breaking decisions and cannot be described as current lifecycle invariants.

- The Structural Seed's `TransportErrorCode`, structured `TransportError`, `fatal` flag and `sequence-exhausted` code are all new interfaces. The current `TransportEvent.error` is `unknown`, implementations emit ordinary `Error`, and none of the named types/codes exists in source or README. AD-12 is unlabeled, so the Seed falsely looks like a transcription of current contracts; mark this error model `[NEW-ADOPTED]` and define conversion from all current plain-error paths.

- AD-14 is incompatible with the current SDK operation algorithm. Current code writes a synthetic `accepted` status with `revision: 0` into the same operation Map and permits an authoritative same-revision notification to replace it. The Spine forbids optimistic entries in the revision cache and accepts only strictly newer revisions. It also adds a 1000-entry SDK limit and terminal-first eviction that exist only on the Server today. These are new Store semantics, not a refactor-preserving description, and require an explicit decision plus Client/API migration behavior for `getOperationStatus()` immediately after `sendInput()` resolves.

- AD-18 combines current Server behavior with unimplemented lifecycle changes. `(connectionId, operationId)` deduplication and continuing queued work after disconnect are current; repeated `session.open` currently rewrites `clientName` and broadcasts every time, and queued jobs retain a `notifyStatus` closure over the old Session. Idempotent open/name-update rules and a no-op sink that releases Session references are new Server behavior and must be marked `[NEW-ADOPTED]`, with corresponding server integration tests.

- Source Ownership presents `sdk-state-store.ts`, `operation-store.ts`, `errors.ts` and `composition-root.ts` as normal source files although none exists. It also omits the current `send-input-error.ts`, effectively implying an unannounced file/API migration, and even indents `operation-store.ts` as though nested under a file. Label the block `Target / New Files`, map each current owner to its target file, and state that `SendInputError` remains exported regardless of internal relocation.

- `RemoteInputClientContract` is a newly named interface that does not exist or export from `@remote-copy/sdk`; current reality exposes the concrete `RemoteInputClient` class. The Seed does not say whether this is documentation-only pseudotype or a new public export. Mark it as a new internal design aid or explicitly adopt it as a public API and add it to export/README verification requirements.

- The global listener-isolation convention is only partially current. ProtocolSession and both Socket.IO transports catch listener exceptions, but `RemoteInputClient` state, notification and operation listeners are invoked directly and one throw stops later listeners and state-flow callbacks. Applying the convention to the SDK is a behavioral change and must be labeled new, assigned an error-reporting destination, and covered by SDK tests.

- The Spine lacks a single brownfield delta ledger even though it changes public contracts. Frontmatter sources omit `apps/client/src`, root/SDK/Protocol Chinese READMEs, manifests and `pnpm-lock.yaml`, despite relying on them for compatibility and versions. Add those evidence sources and a `Current -> Target -> Classification -> Required migration/tests/docs` table covering `subscribe/receive`, connect cancellation, TransportError, OperationStore semantics, new SDK files, `createSession`, listener isolation and Server session lifecycle; the generic update sentence at line 519 is not enough to prevent accidental breaking implementation.

## Evidence Summary

- Verified versions: `package.json:25-28`, workspace manifests, `pnpm-lock.yaml` package snapshots, and current `node --version` / `pnpm --version` / `pnpm exec turbo --version` / `pnpm exec tsc --version`.
- Current Transport contract: `packages/protocol/src/definitions/message-transport.ts:1-39`.
- Current SDK lifecycle and operation behavior: `packages/sdk/src/remote-input-client.ts:94-155`, `181-196`, `279-306`.
- Current Client dependency surface: `apps/client/src/hooks/use-remote-input.ts`, `apps/client/src/types/remote-input.ts`, and connection components.
- Current Server lifecycle: `apps/server/src/socket-io/protocol-server.ts:53-161` and `apps/server/src/input/inputQueue.ts:20-104`.
