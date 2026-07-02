# Task 1 Report: SDK WebSocket Transport

## Result

Task 1 completed: SDK-only WebSocket transport added alongside the existing BLE transport.

## TDD Evidence

### RED

Ran:

```bash
npm --prefix sdk run test:sdk
```

Initial failure was expected and confirmed the missing export path:

- `assert.equal(typeof remoteInputGlobal.connectWs, "function");`
- actual value was `undefined`

This showed the SDK build did not yet expose `connectWs`.

### GREEN

After implementing the WebSocket transport, exports, and types, ran:

```bash
npm --prefix sdk run test:sdk
```

Result:

- `sdk protocol tests passed`

## Files Changed

- `sdk/src/types.ts`
- `sdk/src/index.ts`
- `sdk/src/transport/ws.ts`
- `sdk/tests/sdk-protocol.test.js`

## What Changed

- Added WebSocket type definitions to support a browser transport abstraction.
- Implemented `WsTransport` and `connectWs(url?)` with default URL `ws://192.168.4.1/ws`.
- Exported `connectWs` from the SDK entrypoint and attached it to `RemoteInput`.
- Extended SDK protocol tests with a `FakeWebSocket` harness and coverage for:
  - missing WebSocket support
  - default URL
  - explicit URL
  - successful typing flow
  - disconnect handling
  - invalid status frames
  - connection failure handling

## Verification

- `npm --prefix sdk run test:sdk`

## Concerns / Notes

- `sdk/package-lock.json` exists as an untracked dependency-install artifact and was intentionally not included in the commit.
- No firmware, docs, or demo UI files were modified.
- Hardware/BLE device validation was not part of this task and was not run.

## Follow-up Fix

### What Changed

- Tightened `connectWs()` so the first WebSocket message must decode as a valid v1 14-byte status frame before the promise resolves.
- Added a regression test that proves an invalid first WebSocket message rejects `connectWs()` with `INVALID_STATUS_FRAME`.

### Test Command and Result

```bash
npm --prefix sdk run test:sdk
```

Result: `sdk protocol tests passed`

### Files Changed

- `sdk/src/transport/ws.ts`
- `sdk/tests/sdk-protocol.test.js`

### Concerns

- `sdk/package-lock.json` is still present as an untracked local install artifact and was intentionally excluded from the commit.
- No hardware or browser-runtime verification was performed beyond the automated SDK test suite.
