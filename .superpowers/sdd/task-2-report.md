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

- Reworked `ws_handler()` so every WebSocket frame routed to the handler is fully consumed before returning.
- Added a bounded payload receive/drain helper:
  - binary/control frames within the fixed protocol buffer are received with `httpd_ws_recv_frame()`
  - oversized or otherwise non-protocol frames are drained with a small fixed buffer via `httpd_req_recv()` until the frame payload is fully consumed
- Updated frame handling behavior:
  - `CLOSE`: consume payload first, then remove the client and emit `on_disconnect()`
  - `PING`/`PONG`: consume payload and return cleanly without leaving unread bytes
  - text / other non-binary frames: consume payload, report `REMOTE_INPUT_ERR_INVALID_COMMAND`, and return cleanly
  - oversized binary frames: consume payload under the fixed max buffer policy and report `REMOTE_INPUT_ERR_INVALID_COMMAND`
- Reordered initial WebSocket connection lifecycle so `on_connect()` fires only after the initial status frame is sent successfully.
- Added a low-risk guard for `esp_netif_create_default_wifi_ap()` returning `NULL`, returning `ESP_ERR_NO_MEM` in that case.

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

- The payload drain path for oversized/non-binary frames uses `httpd_req_recv()` after the initial WebSocket header parse. This matches ESP-IDF 6.0.2 behavior in this environment, but it is still only build-verified here, not exercised against a live browser/client session.
- No hardware/runtime validation was performed for actual connect/disconnect, close handshake edge cases, or browser-generated ping/pong traffic in this environment.
