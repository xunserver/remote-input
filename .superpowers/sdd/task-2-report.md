# Task 2 Report: Firmware WebSocket Receiver

## Scope

Implemented Task 2 receiver scaffolding only in the firmware worktree at `/home/xun/project/remote-input/.worktrees/websocket-network-protocol`.

Did not modify `remote_input_service.c`, display/demo files, or docs outside this report.

## Files Changed

- `firmware/components/remote_input_device/CMakeLists.txt`
- `firmware/components/remote_input_device/Kconfig`
- `firmware/components/remote_input_device/include/remote_input_ws.h`
- `firmware/components/remote_input_device/remote_input_ws.c`
- `firmware/sdkconfig.defaults`

## Implementation Summary

- Added WebSocket receiver Kconfig options and default sdkconfig values exactly as specified in the task brief.
- Added `remote_input_ws.h` exposing:
  - `extern const remote_input_receiver_t remote_input_ws_receiver;`
  - `esp_err_t remote_input_ws_init(const remote_input_receiver_callbacks_t *callbacks);`
  - `void remote_input_ws_notify_status(void);`
- Added `remote_input_ws.c` implementing the existing receiver interface with:
  - Wi-Fi SoftAP initialization
  - HTTP server startup
  - `/ws` WebSocket endpoint
  - binary frame dispatch into existing protocol parsers
  - status broadcast to connected clients
  - callback forwarding for connect, disconnect, control, data, and error paths
- Updated component build sources and added required ESP-IDF dependencies:
  - `esp_event`
  - `esp_http_server`
  - `esp_netif`
  - `esp_wifi`

## Build Verification

Command run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Result: PASS

Key output:

- Generated `firmware/build/remote_input.bin`
- Final binary size reported as `0xbb030 bytes`
- App partition free space reported as `0x44fd0 bytes (27%) free`

## Self-Review

- Confirmed changes are limited to the five Task 2 files required by the brief.
- Confirmed `remote_input_service.c` was not modified.
- Confirmed the new receiver compiles successfully under ESP-IDF `v6.0.2`.
- Confirmed untracked `sdk/package-lock.json` was left untouched and excluded from commit scope.

## Concerns

- No blocking implementation concerns for Task 2 scope.
- Functional runtime behavior of SoftAP startup, WebSocket handshake, multi-client limits, and status delivery was not hardware/runtime verified in this environment.
- Task 2 intentionally does not integrate the receiver into service selection; that remains for Task 3.

## Review Fix Follow-Up

### What changed

- Reworked `ws_handler()` to use only `httpd_ws_recv_frame()` for WebSocket payload receive after the initial `len/type` probe.
- Simplified payload receive logic:
  - `PING` / `PONG` / `CLOSE` / text / other non-binary frames with length `<= REMOTE_INPUT_DATA_FRAME_MAX_LEN` are fully consumed via `httpd_ws_recv_frame()` before handling the frame type.
  - oversized frames now follow the accepted first-version behavior: report `REMOTE_INPUT_ERR_INVALID_COMMAND`, remove the tracked client, emit `on_disconnect()` if needed, and trigger session close instead of attempting any unsupported drain path.
- Added `remove_client_and_notify(int fd)` and routed tracked-client removal through it so send failures, close handling, and receive failures all emit `on_disconnect()` exactly once per actual removal.
- Preserved the earlier connection-lifecycle fix where `on_connect()` fires only after the initial status frame send succeeds.

### Build command and result

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Result: PASS

- Generated `firmware/build/remote_input.bin`
- Final binary size reported as `0xbb030 bytes`
- App partition free space reported as `0x44fd0 bytes (27%) free`

### Files changed

- `firmware/components/remote_input_device/remote_input_ws.c`
- `.superpowers/sdd/task-2-report.md`

### Any concerns

- Corrected the previous report claim about `httpd_req_recv()` drain behavior. The implementation no longer relies on that unsupported receive path.
- No hardware/runtime validation was performed for actual connect/disconnect timing, browser-generated control frames, or oversized-frame close behavior in this environment.
