# WebSocket Network Protocol Design

Date: 2026-07-01

## Goal

Add a WiFi SoftAP and WebSocket input path to the ESP32-S3 firmware so a browser can connect directly to the device and send text input through the existing Remote Input protocol.

The first version keeps BLE support enabled. BLE and WebSocket are parallel input receivers that feed the same `remote_input_core` engine and USB HID writer.

## Non-Goals

- Do not replace BLE.
- Do not add an embedded HTTP UI page to the firmware.
- Do not introduce a new JSON text protocol.
- Do not change protocol version `1`, frame fields, byte order, chunk size, state codes, or error codes.
- Do not add WebSocket token authentication or TLS in the first version.

## User Flow

1. ESP32 boots and starts the existing BLE service.
2. ESP32 also starts a WPA2-protected WiFi SoftAP.
3. The user connects the browser host to the ESP32 AP.
4. The user opens the repository SDK demo from a local development server, such as Vite on `http://localhost`.
5. The SDK connects to:

```text
ws://192.168.4.1/ws
```

6. The SDK sends the same START, DATA, and COMMIT frames used by BLE.
7. The firmware validates and executes the task through the existing engine and USB HID writer.
8. The firmware pushes status frames to connected WebSocket clients and continues notifying BLE clients.

## Architecture

Add a `remote_input_ws` module under:

```text
firmware/components/remote_input_device/
  remote_input_ws.c
  include/remote_input_ws.h
```

The module implements the existing `remote_input_receiver_t` interface. It owns WiFi SoftAP startup, HTTP server startup, the WebSocket endpoint, client tracking, and conversion from WebSocket binary messages to core protocol callbacks.

`remote_input_core` remains transport independent. It must not depend on WiFi, HTTP, WebSocket, sockets, BLE, LCD, LED, or TinyUSB.

`remote_input_service` changes from a single receiver pointer to a receiver list. The first version initializes BLE and WebSocket receivers when enabled. Receiver initialization failures are isolated:

- HID writer initialization failure remains fatal.
- If BLE fails but WebSocket starts, service initialization succeeds.
- If WebSocket fails but BLE starts, service initialization succeeds.
- If every enabled receiver fails, service initialization fails.

Status changes are broadcast to every initialized receiver by calling each receiver's `notify_status()` function.

## WebSocket Protocol

Endpoint:

```text
ws://192.168.4.1/ws
```

The first version accepts only WebSocket binary messages.

Each WebSocket binary message contains exactly one existing Remote Input v1 frame:

- A 12-byte START or COMMIT control frame.
- An 8-to-20-byte DATA frame.

The firmware determines frame kind from the existing frame length and type byte:

- Length `12` and type START or COMMIT: parse with `remote_input_parse_control_frame()`.
- Length `8..20` and type DATA: parse with `remote_input_parse_data_frame()`.
- Text messages and unknown binary messages are rejected and reported as receiver errors.

Status messages sent from firmware to browser are the existing 14-byte status frame encoded by `remote_input_status_encode()`.

When a WebSocket client connects, the firmware sends the current status frame immediately. This gives the browser an initial status snapshot without adding a request/response message type.

No WebSocket envelope is added in version 1. The inner frame bytes are identical to BLE writes.

## Error Handling

The WebSocket receiver reports transport-level invalid input through the existing receiver error callback:

- Text WebSocket message: `REMOTE_INPUT_ERR_INVALID_COMMAND`.
- Binary message that cannot be classified: `REMOTE_INPUT_ERR_INVALID_COMMAND`.
- Binary message classified as DATA but failing DATA parsing: `REMOTE_INPUT_ERR_INVALID_CHUNK`.
- Binary message classified as control but failing control parsing: `REMOTE_INPUT_ERR_INVALID_COMMAND`.

The engine continues to own task-level validation:

- busy output
- duplicate chunks
- missing chunks
- task size
- invalid UTF-8
- HID readiness and write failures

If a WebSocket client disconnects, the receiver emits a disconnect callback. `remote_input_service` only resets receive state to idle when no BLE or WebSocket clients remain connected and the writer runner is not busy. Already submitted HID output is not interrupted by a WebSocket disconnect.

## Connection State

The visible connected state means "at least one input client is connected." A connected input client can be BLE or WebSocket.

The existing LED and LCD updates should move toward this transport-neutral meaning. If display APIs still contain BLE-specific names, the implementation should adapt inside `remote_input_service` or add a transport-neutral wrapper without changing core behavior.

## Configuration

Add Kconfig options under `Remote Input Device`:

```text
CONFIG_REMOTE_INPUT_WS_ENABLED=y
CONFIG_REMOTE_INPUT_WIFI_AP_SSID="Remote-Input-S3"
CONFIG_REMOTE_INPUT_WIFI_AP_PASSWORD="remoteinput"
CONFIG_REMOTE_INPUT_WIFI_AP_CHANNEL=6
CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS=1
```

The AP password must satisfy WPA requirements, including a minimum length of 8 characters. The first implementation should use WPA2-PSK unless the selected ESP-IDF APIs make WPA2/WPA3 compatibility straightforward without extra complexity.

`CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS` defaults to `1`. BLE may still be connected at the same time. The single-client WebSocket default avoids ambiguous browser-to-browser contention in the first version while preserving BLE/WS coexistence.

## Browser SDK

Add a WebSocket transport that implements `RemoteInputTransport`:

```text
sdk/src/transport/ws.ts
```

Add a public connector:

```ts
connectWs(url?: string): Promise<RemoteInputClient>
```

Default URL:

```text
ws://192.168.4.1/ws
```

`RemoteInputClient` should not need transport-specific changes. It continues to call `writeControl()`, `writeData()`, `readStatus()`, and listen for status/disconnect events.

`WsTransport.writeControl()` and `WsTransport.writeData()` send binary messages. Incoming binary WebSocket messages are delivered as status frames to existing status listeners and cached as the latest status. `readStatus()` returns the latest cached status. Because the firmware sends an initial status frame on WebSocket connect, `connectWs()` should wait for that first valid status frame before returning the `RemoteInputClient`.

The SDK demo should expose a WebSocket connection path and allow the user to use the default URL or provide a custom URL. The existing BLE path remains available.

Because the endpoint is `ws://`, the demo should be served from an HTTP secure-enough local development origin such as `http://localhost`. A production HTTPS page may block plain WebSocket mixed content.

## Security

The first version relies on the AP password to restrict who can connect. It does not add:

- WebSocket URL token.
- TLS.
- Per-client authorization.
- BLE authentication changes.

Documentation must clearly state that anyone with the AP password can connect to the WebSocket endpoint and inject keyboard input into the USB host.

## Testing

SDK automated tests should cover:

- `connectWs()` uses `ws://192.168.4.1/ws` by default.
- WebSocket open plus the initial status frame creates a connected `RemoteInputClient`.
- `writeControl()` and `writeData()` send binary frames.
- `readStatus()` returns the latest cached status frame.
- A binary 14-byte status frame drives an existing `RemoteInputClient.typeText()` call to completion.
- WebSocket close rejects a pending task with a disconnect error.
- Invalid status messages produce the existing invalid status behavior.
- Existing BLE tests continue to pass.

Run:

```text
npm --prefix sdk run test:sdk
```

Firmware validation:

```text
eim run "idf.py -C firmware -B firmware/build build"
```

Hardware validation is required outside the agent environment:

1. ESP32 starts the `Remote-Input-S3` WPA2 AP.
2. A browser host connects to the AP.
3. The SDK demo connects to `ws://192.168.4.1/ws`.
4. Sending text through WebSocket produces USB HID input on the target host.
5. BLE and WebSocket each work independently.
6. BLE and WebSocket can be connected at the same time.
7. During an active task, a second task from the other transport receives busy/error behavior without corrupting the active task.
8. Disconnecting WebSocket updates LED/LCD connected state according to the "at least one client" rule.

## Acceptance Criteria

- BLE behavior remains available.
- Browser WebSocket input uses the same binary protocol as BLE.
- Firmware status updates are sent to both BLE and WebSocket clients.
- Core protocol code remains transport independent.
- The SDK exposes `connectWs()` and keeps the existing `RemoteInputClient` abstraction.
- SDK tests pass.
- Firmware builds with ESP-IDF through `eim run`.
