# Large Text Protocol v2 Design

## Goal

Upgrade Remote Input to protocol version 2 so one input task can reliably carry about 5000 Chinese characters with room for punctuation, mixed text, and future growth.

The new protocol does not need to be compatible with version 1. BLE and WebSocket must move together to the same v2 frame format. The browser SDK should be refactored so protocol framing and task sending are shared by both transports.

## Requirements

- Protocol version is `2`.
- Maximum UTF-8 text length is `128 * 1024` bytes.
- Data frame payload size is fixed at `180` bytes.
- BLE and WebSocket use the same START, DATA, COMMIT, CONFIG, and STATUS frame formats.
- Version 1 frames are rejected.
- SDK rejects text over 128 KB before sending.
- Firmware also rejects tasks over 128 KB.
- Current hardware flashing, serial monitor, and real device input checks remain outside this agent environment.

## Non-Goals

- No version negotiation.
- No backward compatibility with protocol v1.
- No stream-to-HID execution while data is still arriving.
- No disk, flash, PSRAM, or filesystem buffering.
- No change to the public `typeText(text)` workflow unless needed for error reporting.

## Protocol

Protocol constants:

```text
REMOTE_INPUT_PROTOCOL_VERSION = 2
REMOTE_INPUT_MAX_TEXT_BYTES = 128 * 1024
REMOTE_INPUT_DATA_PAYLOAD_BYTES = 180
REMOTE_INPUT_CONTROL_FRAME_LEN = 12
REMOTE_INPUT_DATA_FRAME_HEADER_LEN = 8
REMOTE_INPUT_STATUS_FRAME_LEN = 14
```

Control frames remain 12 bytes:

```text
0: uint8  version
1: uint8  type
2: uint16 task_id
4: uint32 total_bytes
8: uint16 total_chunks
10: uint16 reserved
```

CONFIG frames remain 12 bytes:

```text
0: uint8  version
1: uint8  type
2: uint16 flags
4: uint16 key_delay_ms
6: bytes[6] reserved
```

Data frames remain `8 + payload_len` bytes:

```text
0: uint8  version
1: uint8  type
2: uint16 task_id
4: uint16 chunk_index
6: uint16 total_chunks
8: bytes[payload_len] payload
```

`payload_len` is `0..180`. Empty text still uses one DATA frame with zero payload.

Status frames remain 14 bytes and keep the same fields. Only the version byte changes to `2`.

`total_chunks` is `ceil(total_bytes / 180)`, except empty text uses `1`. With a 128 KB limit, the maximum non-empty task has 729 chunks, so `uint16` remains sufficient.

## Firmware Core

`remote_input_task_buffer_t` must stop embedding the text buffer and the chunk bitmap. The old 16 KB static buffer would become too large if expanded directly.

The task buffer should instead own dynamically allocated memory:

```text
uint8_t *buffer
uint8_t *chunk_seen
uint32_t total_bytes
uint16_t total_chunks
uint32_t received_bytes
uint16_t received_chunks
remote_input_config_t config
bool active
```

START validates the frame, allocates `buffer` with `total_bytes` bytes, allocates `chunk_seen` with `total_chunks` bytes, clears both allocations, then marks the task active. Empty text may allocate no text buffer but still tracks one chunk.

DATA validates `task_id`, `total_chunks`, `chunk_index`, duplicate state, offset, and expected payload length. It writes payload bytes at `chunk_index * 180`.

COMMIT validates that all chunks arrived, then submits the complete UTF-8 byte span to the writer runner. After submit succeeds or fails, receive-side task memory is released.

Any receive reset, parse error that invalidates the task, commit error, or service shutdown path must release owned memory.

Allocation failure should map to `REMOTE_INPUT_ERR_TASK_TOO_LARGE`. This keeps the error model simple: the device cannot accept the requested task size.

## Writer Runner

The writer runner currently copies submitted text into a fixed-size job buffer. That must change before 128 KB tasks are accepted.

The runner should allocate job memory sized to the submitted text, copy the submitted bytes, and enqueue a pointer to the job. The worker owns the job after enqueue and frees it after writing completes.

The queue length remains `1`, and the engine still allows only one active receive task and one active writer task. This bounds memory use to one receive buffer plus one queued/writing copy during the commit handoff.

If allocation or queue submission fails, the runner returns `REMOTE_INPUT_ERR_TASK_TOO_LARGE` or `REMOTE_INPUT_ERR_DEVICE_BUSY` according to the failing condition, and no memory is leaked.

## BLE Transport

The BLE service keeps the same UUIDs.

The Data characteristic should add write-without-response support while retaining write-with-response support:

```text
Data flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP
```

Control remains write-with-response. Status remains read and notify.

The BLE receiver stack buffer for Data frames becomes `8 + 180` bytes.

On connect, firmware should request low-latency connection parameters and configure or log preferred MTU behavior:

- request a short interval such as `7.5..15 ms`
- request latency `0`
- use a valid supervision timeout such as `4 s`
- log connection update events
- log MTU update events

The central device may reject or alter these parameters. Rejection must not break correctness.

## WebSocket Transport

WebSocket stays binary-only and keeps `ws://192.168.4.1/ws`.

Each message still carries exactly one protocol frame. The maximum accepted inbound frame grows from 20 bytes to 188 bytes.

Fragmented frames and continuation frames remain invalid. Text frames remain invalid. Initial connection status push remains unchanged except for status version `2`.

## SDK Refactor

The SDK should separate responsibilities:

- `protocol.ts`: constants, frame encoding, status decoding, config validation, text size validation, and data frame generation.
- `RemoteInputClient`: task lifecycle, pending promise, status handling, config management, and disconnect behavior.
- transport implementations: connection setup, read status, status listeners, disconnect handling, and raw frame writing.

The shared sending flow should generate START, DATA, and COMMIT once, then call the transport methods. BLE and WebSocket must not duplicate protocol framing.

The transport interface should support the BLE optimization without leaking Web Bluetooth details into `RemoteInputClient`. One acceptable shape is:

```text
writeControl(frame)
writeData(frame)
```

where BLE internally chooses `writeValueWithoutResponse` for DATA when available, and falls back to `writeValueWithResponse`. Another acceptable shape is a raw write method plus a frame kind. The implementation should follow the existing codebase style and keep the public API stable.

Type definitions for `RemoteBluetoothCharacteristic` must include optional `writeValueWithoutResponse`.

## Error Handling

- SDK text over 128 KB: `TEXT_TOO_LARGE`.
- Firmware START over 128 KB: `REMOTE_INPUT_ERR_TASK_TOO_LARGE`.
- Version mismatch: `INVALID_COMMAND` for Control/CONFIG, `INVALID_CHUNK` for DATA.
- Invalid DATA length, duplicate chunk, missing chunk, or wrong payload length keep the existing error meanings.
- Allocation failure while accepting a task maps to `TASK_TOO_LARGE`.
- Allocation failure while enqueueing a writer job maps to `TASK_TOO_LARGE`.
- Transport write failure keeps the existing transport-specific SDK error prefix.

## Tests

SDK tests should cover:

- protocol version is `2`
- maximum text size is 128 KB
- data payload size is 180 bytes
- frame generation for small text, exact 180-byte boundaries, multi-frame text, and empty text
- rejection above 128 KB
- status decoding expects version `2`
- BLE DATA prefers `writeValueWithoutResponse` when available
- BLE DATA falls back to `writeValueWithResponse`
- Control frames still use `writeValueWithResponse`
- WebSocket sends v2 frames with 180-byte chunks

Firmware build verification:

```text
eim run "idf.py -C firmware -B firmware/build build"
```

SDK verification:

```text
npm --prefix sdk run test:sdk
```

Manual or hardware verification still needed:

- BLE actual MTU and connection parameter behavior on Chrome or Edge.
- Web Bluetooth `writeValueWithoutResponse()` behavior on the target browser and OS.
- 5000 Chinese character input latency.
- USB HID long text stability.
- LED and display states during long receive and long typing phases.

## Documentation Updates

`docs/remote-input-protocol.md` must be rewritten for v2:

- protocol version `2`
- 128 KB maximum text length
- 180-byte Data payload
- BLE Data characteristic supports write without response
- WebSocket binary message maximum is 188 bytes for DATA
- v1 compatibility is intentionally removed

## Implementation Order

1. Update SDK tests for v2 constants and expected large chunks.
2. Refactor SDK protocol generation and transport typing.
3. Update BLE transport to prefer write without response for DATA.
4. Update firmware protocol constants and parsers.
5. Convert firmware receive task buffer to dynamic allocation.
6. Convert writer runner job storage to dynamic allocation.
7. Expand BLE and WebSocket frame receive limits.
8. Add BLE connection parameter and MTU logging/request behavior.
9. Update protocol documentation.
10. Run SDK tests and firmware build.

