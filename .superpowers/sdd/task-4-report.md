# Task 4 Report

## Completed Changes

- Updated `sdk/index.html` demo toolbar to support BLE and WebSocket connection entry points.
- Added `ws://192.168.4.1/ws` input handling and `RemoteInput.connectWs()` wiring in the demo.
- Updated `docs/remote-input-protocol.md` with the WebSocket transport section, the SoftAP defaults, binary message mapping, status push behavior, and the security boundary.
- Renumbered later protocol sections so the headings remain monotonic.

## Verification

### SDK tests

Command:

```bash
npm --prefix sdk run test:sdk
```

Result: passed. The command built `sdk/dist/remote-input-sdk.js` and ended with `sdk protocol tests passed`.

### Firmware build

Command:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Result: passed. The build completed successfully and generated `firmware/build/remote_input.bin`.

### Final diff checks

Commands:

```bash
git status --short
git diff --check
git diff --stat
```

Result:

- `git diff --check` produced no output.
- Tracked changes were limited to `docs/remote-input-protocol.md` and `sdk/index.html`.
- `sdk/package-lock.json` remained untracked and was not included in the commit.

## Commit

- `e5fe26b` `docs: describe websocket transport`

## Concerns

- No hardware verification was run in this environment.
- The WebSocket demo and protocol documentation were updated, but connecting to the ESP32 SoftAP and exercising live WebSocket traffic still needs confirmation on hardware-capable test equipment.

## Review Fix: Transport-Neutral Protocol Wording

### What changed

- Updated `docs/remote-input-protocol.md` so Control, Data, and Status frame definitions distinguish BLE characteristic behavior from WebSocket binary message behavior.
- Updated the normal send flow to describe sending frames through the active transport instead of only writing BLE characteristics.
- Renamed the outdated WiFi future-support section to a generic future transport extension section and removed WebSocket-obsolete WiFi-specific wording.
- Protocol bytes, frame sizes, field layouts, status codes, and error codes were unchanged.

### Verification

Command:

```bash
git diff --check
```

Result: passed with no output.

### Files changed

- `docs/remote-input-protocol.md`
- `.superpowers/sdd/task-4-report.md`

### Concerns

- Documentation-only fix; SDK and firmware suites were not rerun.

## Review Fix: WebSocket/SoftAP Defaults Table

### What changed

- Updated the WebSocket/SoftAP defaults table in `docs/remote-input-protocol.md` to include the binding plan constraints for AP channel `6` and maximum client count `1`.

### Verification

Command:

```bash
git diff --check
```

Result: passed with no output.

### Files changed

- `docs/remote-input-protocol.md`
- `.superpowers/sdd/task-4-report.md`

### Concerns

- Documentation-only fix; no runtime behavior changed and no hardware verification was needed for this table update.
