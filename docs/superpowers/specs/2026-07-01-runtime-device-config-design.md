# Runtime Device Config Design

## Summary

Add a runtime-only device configuration path so the browser SDK can set device parameters after connecting and update them while the device remains connected. The first supported parameter is `keyDelayMs`, which controls the delay between USB HID keyboard reports.

Configuration is not persisted. Rebooting the ESP32-S3 restores the firmware default. Dynamic updates affect only future text input tasks; an input task keeps the configuration snapshot captured when it was submitted to the writer.

## Goals

- Let SDK users set `keyDelayMs` after connection.
- Let SDK users update `keyDelayMs` while connected.
- Support both BLE and WebSocket transports through the existing binary protocol model.
- Keep existing START, DATA, COMMIT, and STATUS frames compatible.
- Keep the default behavior unchanged when no configuration is sent.

## Non-Goals

- No NVS persistence.
- No configuration readback from the device.
- No immediate speed changes for a task that is already typing.
- No authentication, pairing, or transport security changes.
- No additional configurable parameters in the first implementation.

## Parameter

`keyDelayMs` controls the delay after each HID keyboard report.

| Field | Type | Range | Default |
| --- | --- | --- | --- |
| `keyDelayMs` | `uint16` milliseconds | `1..200` | `20` |

The `1ms` lower bound avoids a zero-delay loop that could overload TinyUSB or the USB host. The `200ms` upper bound covers practical slow typing without supporting extreme delays.

## Protocol

Add a new Control-channel frame type:

| Value | Name | Direction |
| ---: | --- | --- |
| `3` | `CONFIG` | SDK -> ESP32 |

`CONFIG` is a fixed 12-byte frame. BLE writes it to the existing Control characteristic. WebSocket sends it as one binary message, matching the existing transport-neutral frame model.

| Offset | Length | Type | Field | Description |
| --- | ---: | --- | --- | --- |
| 0 | 1 | `uint8` | `version` | Must be `1` |
| 1 | 1 | `uint8` | `type` | Must be `3` |
| 2 | 2 | `uint16` | `flags` | Must be `0` |
| 4 | 2 | `uint16` | `key_delay_ms` | Must be `1..200` |
| 6 | 6 | bytes | `reserved` | Must be all zero |

Validation rules:

- `version` must equal `1`.
- `type` must equal `CONFIG`.
- `flags` must be `0`.
- `key_delay_ms` must be in `1..200`.
- Reserved bytes must be zero.

Invalid `CONFIG` frames do not change the current runtime configuration. The device reports `INVALID_COMMAND` through the existing status error path.

## SDK API

Add a public config type:

```ts
export interface RemoteInputConfig {
  keyDelayMs: number;
}
```

Add methods to `RemoteInputClient`:

```ts
setConfig(config: RemoteInputConfig): Promise<void>
getConfig(): RemoteInputConfig
```

`setConfig()` validates `keyDelayMs` locally before writing. It rejects without sending when the value is not an integer in `1..200`. It requires an active connection. After the transport write succeeds, it updates the SDK local config cache.

`getConfig()` returns the SDK local config cache. It does not read from the device. The cache starts with `{ keyDelayMs: 20 }`.

Add connect options:

```ts
connectBle({ config: { keyDelayMs: 10 } })
connectWs(url, { config: { keyDelayMs: 10 } })
```

If connect options include `config`, the SDK sends one `CONFIG` frame after the transport is connected and ready. If no config is provided, no extra frame is sent and the device keeps its default runtime config.

Transport write failures reject `setConfig()` using the existing transport-specific write error style, such as `BLE_WRITE_FAILED` or `WS_WRITE_FAILED`.

## Firmware Architecture

Add a runtime configuration holder with default values:

```c
typedef struct {
    uint16_t key_delay_ms;
} remote_input_config_t;
```

The config holder exposes:

- initialization to default values during service startup;
- validation and update from a parsed `CONFIG` frame;
- copying the current config for writer jobs.

The receiver path parses `CONFIG` on the same Control channel as START and COMMIT. The service or engine applies valid config frames to the runtime config holder. START, DATA, COMMIT, task state, and status frame layout remain unchanged.

`remote_input_writer_runner_submit()` captures the current runtime config into `writer_job_t`. The HID writer uses the job snapshot's `key_delay_ms` for its report delay instead of the compile-time `REMOTE_INPUT_HID_DELAY_MS` value. Later `CONFIG` frames update the runtime config holder but do not mutate an already queued or active job.

## Data Flow

Connection-time configuration:

1. SDK connects through BLE or WebSocket.
2. If connect options include `config`, SDK validates it.
3. SDK encodes and writes one `CONFIG` frame on the Control channel.
4. Firmware validates the frame and updates runtime config.
5. Later `typeText()` tasks use the updated config snapshot.

Dynamic configuration:

1. Application calls `client.setConfig({ keyDelayMs })`.
2. SDK validates and writes `CONFIG`.
3. Firmware updates runtime config if valid.
4. Any current typing task continues with its existing snapshot.
5. Future typing tasks capture the new config.

## Error Handling

- SDK rejects `setConfig()` with `NOT_CONNECTED` when disconnected.
- SDK rejects invalid `keyDelayMs` before writing.
- SDK rejects transport write failures with the current transport write error pattern.
- Firmware rejects malformed or out-of-range `CONFIG` frames as `INVALID_COMMAND`.
- Firmware keeps the previous runtime config when a `CONFIG` frame is invalid.
- `setConfig()` is allowed while a text task is pending or typing. It does not resolve or reject the pending text task.

## Compatibility

Existing SDK versions continue to work because the default firmware config remains `keyDelayMs = 20`, and existing frame formats are unchanged.

Existing firmware versions will reject the new `CONFIG` frame as an invalid control command. SDK users who need compatibility with older firmware should avoid passing connect-time config or calling `setConfig()` until firmware capability detection exists. This design does not add capability detection.

## Tests and Verification

SDK tests:

- encode `CONFIG` frames with the expected byte layout;
- accept boundary values `1` and `200`;
- reject `0`, `201`, non-integer, and non-number values;
- verify `setConfig()` writes one Control frame and updates local config after success;
- verify `setConfig()` does not update local config after write failure;
- verify connect options send one `CONFIG` frame after connection setup.

Firmware checks:

- parser accepts valid `CONFIG` and rejects invalid version, type, flags, range, and reserved bytes;
- runtime config defaults to `20ms`;
- valid config updates runtime state;
- invalid config preserves previous runtime state;
- writer jobs capture config snapshots at submit time.

Build verification:

```sh
npm --prefix sdk run test:sdk
eim run "idf.py -C firmware -B firmware/build build"
```

Hardware validation remains required outside this agent environment:

- confirm visible typing speed changes at representative values such as `1ms`, `10ms`, `20ms`, and `200ms`;
- check whether very low delays cause missed keys on target USB hosts;
- confirm changing config during a long typing task affects the next task, not the active one.
