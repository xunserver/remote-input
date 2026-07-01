# Runtime Device Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime-only SDK-controlled `keyDelayMs` configuration for BLE and WebSocket remote input.

**Architecture:** Add a transport-neutral 12-byte `CONFIG` Control frame. The SDK validates and writes config frames through the existing Control channel; firmware parses valid config frames into a runtime config holder; writer jobs snapshot the current config so dynamic changes affect only future typing tasks.

**Tech Stack:** TypeScript ES modules, Vite IIFE SDK build, Node `assert` SDK tests, ESP-IDF 6.0.2 C firmware, BLE GATT, WebSocket binary messages, TinyUSB HID.

## Global Constraints

- Configuration is not persisted; reboot restores default `keyDelayMs = 20`.
- `keyDelayMs` is a `uint16` millisecond value with allowed range `1..200`.
- `CONFIG` is a 12-byte SDK -> ESP32 frame on the existing Control channel.
- `CONFIG` frame layout: version byte `1`, type byte `3`, `flags` uint16 little-endian `0`, `key_delay_ms` uint16 little-endian, six reserved zero bytes.
- Dynamic updates affect only future text input tasks; active or queued writer jobs keep their captured config snapshot.
- Existing START, DATA, COMMIT, and STATUS frame layouts remain unchanged.
- Existing SDK users who do not send config keep the default `20ms` behavior.
- Do not add NVS persistence, device readback, capability detection, authentication, or extra config parameters.
- SDK changes must pass `npm --prefix sdk run test:sdk`.
- Firmware changes must pass `eim run "idf.py -C firmware -B firmware/build build"`.
- Do not run `idf.py flash`, `idf.py monitor`, or commands containing `flash` or `monitor`.

---

## File Structure

- `sdk/src/constants.ts`: add `CONTROL_CONFIG`, config defaults, and min/max constants.
- `sdk/src/types.ts`: add `RemoteInputConfig`.
- `sdk/src/protocol.ts`: add `encodeConfigFrame()` and `assertConfig()`, export config constants through `constants`.
- `sdk/src/device.ts`: add SDK local config cache, `setConfig()`, `getConfig()`, and optional constructor initial config.
- `sdk/src/transport/types.ts`: no new transport method; config uses `writeControl()`.
- `sdk/src/transport/ble.ts`: add `ConnectBleOptions`, accept optional connect-time config, and pass it to `RemoteInputClient`.
- `sdk/src/transport/ws.ts`: extend `ConnectWsOptions` with optional `config` and pass it to `RemoteInputClient`.
- `sdk/src/index.ts`: export `RemoteInputConfig` if type exports are centralized there.
- `sdk/tests/sdk-protocol.test.js`: add protocol and SDK flow assertions for config.
- `firmware/components/remote_input_core/include/remote_input_protocol.h`: add `REMOTE_INPUT_CONTROL_CONFIG`, config frame length assumptions, and `remote_input_config_frame_t`.
- `firmware/components/remote_input_core/remote_input_protocol.c`: parse `CONFIG` frames.
- `firmware/components/remote_input_core/include/remote_input_receiver.h`: add config callback type and field.
- `firmware/components/remote_input_core/include/remote_input_engine.h`: add config callback type and `remote_input_engine_handle_config()`.
- `firmware/components/remote_input_core/remote_input_engine.c`: apply parsed config through callback and report invalid config as `INVALID_COMMAND`.
- `firmware/components/remote_input_device/include/remote_input_config.h`: new runtime config API.
- `firmware/components/remote_input_device/remote_input_config.c`: new runtime config implementation.
- `firmware/components/remote_input_device/CMakeLists.txt`: add `remote_input_config.c`.
- `firmware/components/remote_input_device/remote_input_ble.c`: route Control writes with type `3` to `on_config`.
- `firmware/components/remote_input_device/remote_input_ws.c`: accept 12-byte WebSocket `CONFIG` frames and route to `on_config`.
- `firmware/components/remote_input_device/remote_input_service.c`: initialize config, handle config callback, pass config snapshots into writer runner.
- `firmware/components/remote_input_core/include/remote_input_writer.h`: extend writer API to accept a config snapshot.
- `firmware/components/remote_input_device/include/remote_input_writer_runner.h`: extend submit API to accept a config snapshot.
- `firmware/components/remote_input_device/remote_input_writer_runner.c`: store config in `writer_job_t` and pass it to writer.
- `firmware/components/remote_input_device/include/remote_input_hid.h`: expose configurable HID write function signature.
- `firmware/components/remote_input_device/remote_input_hid.c`: use `key_delay_ms` from job config instead of fixed `REMOTE_INPUT_HID_DELAY_MS`.
- `docs/remote-input-protocol.md`: document the new CONFIG frame.

---

### Task 1: SDK Protocol and Client Config API

**Files:**
- Modify: `sdk/src/constants.ts`
- Modify: `sdk/src/types.ts`
- Modify: `sdk/src/protocol.ts`
- Modify: `sdk/src/device.ts`
- Modify: `sdk/src/transport/ble.ts`
- Modify: `sdk/src/transport/ws.ts`
- Modify: `sdk/src/index.ts`
- Test: `sdk/tests/sdk-protocol.test.js`

**Interfaces:**
- Consumes: existing `RemoteInputTransport.writeControl(frame: Uint8Array): Promise<void>`.
- Produces: `RemoteInputConfig`, `CONTROL_CONFIG`, `DEFAULT_KEY_DELAY_MS`, `MIN_KEY_DELAY_MS`, `MAX_KEY_DELAY_MS`, `encodeConfigFrame(config: RemoteInputConfig): Uint8Array`, `assertConfig(config: RemoteInputConfig): void`, `RemoteInputClient.setConfig(config: RemoteInputConfig): Promise<void>`, `RemoteInputClient.getConfig(): RemoteInputConfig`, `connectBle(options?: ConnectBleOptions): Promise<RemoteInputClient>`, `connectWs(url?: string, options?: ConnectWsOptions): Promise<RemoteInputClient>`.

- [ ] **Step 1: Add failing protocol tests for CONFIG constants, encoding, and validation**

Add this block after the existing constants assertion in `sdk/tests/sdk-protocol.test.js`:

```js
{
  const { constants } = internals;
  assert.equal(constants.CONTROL_CONFIG, 3);
  assert.equal(constants.DEFAULT_KEY_DELAY_MS, 20);
  assert.equal(constants.MIN_KEY_DELAY_MS, 1);
  assert.equal(constants.MAX_KEY_DELAY_MS, 200);
}

{
  const frame = internals.encodeConfigFrame({ keyDelayMs: 10 });
  assert.equal(frame.byteLength, 12);
  assert.deepEqual(Array.from(frame), [1, 3, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
}

{
  assert.equal(internals.assertConfig({ keyDelayMs: 1 }), undefined);
  assert.equal(internals.assertConfig({ keyDelayMs: 200 }), undefined);
  assert.throws(() => internals.assertConfig({ keyDelayMs: 0 }), /INVALID_CONFIG/);
  assert.throws(() => internals.assertConfig({ keyDelayMs: 201 }), /INVALID_CONFIG/);
  assert.throws(() => internals.assertConfig({ keyDelayMs: 1.5 }), /INVALID_CONFIG/);
  assert.throws(() => internals.assertConfig({ keyDelayMs: Number.NaN }), /INVALID_CONFIG/);
}
```

- [ ] **Step 2: Add failing SDK flow tests for getConfig, setConfig, write failure, and connect-time config**

Add these cases inside `runSdkFlowTests()` in `sdk/tests/sdk-protocol.test.js`, after the first successful WebSocket connection test:

```js
  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    assert.deepEqual(device.getConfig(), { keyDelayMs: 20 });
    await device.setConfig({ keyDelayMs: 10 });
    assert.deepEqual(socket.sent[0], [1, 3, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(device.getConfig(), { keyDelayMs: 10 });
  }

  {
    const { device } = await connectFakeWs(RemoteInput);
    await assertRejectsWithCode(() => device.setConfig({ keyDelayMs: 0 }), "INVALID_CONFIG");
    assert.deepEqual(device.getConfig(), { keyDelayMs: 20 });
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    socket.readyState = FakeWebSocket.CLOSED;
    await assertRejectsWithCode(() => device.setConfig({ keyDelayMs: 10 }), "NOT_CONNECTED");
    assert.deepEqual(device.getConfig(), { keyDelayMs: 20 });
  }
```

Add this helper near `connectFakeWs()`:

```js
async function connectFakeWsWithOptions(RemoteInput, url, options) {
  FakeWebSocket.instances = [];
  FakeWebSocket.throwOnConstruct = null;
  context.WebSocket = FakeWebSocket;
  const promise = RemoteInput.connectWs(url, options);
  await flushMicrotasks();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  socket.openWithInitialStatus();
  const device = await promise;
  return { device, socket };
}
```

Add these cases inside `runSdkFlowTests()` near the other WebSocket connect tests:

```js
  {
    const { device, socket } = await connectFakeWsWithOptions(
      RemoteInput,
      "ws://192.168.4.1/ws",
      { config: { keyDelayMs: 15 } }
    );
    assert.deepEqual(socket.sent[0], [1, 3, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(device.getConfig(), { keyDelayMs: 15 });
  }

  {
    await assertRejectsWithCode(
      () => connectFakeWsWithOptions(RemoteInput, "ws://192.168.4.1/ws", { config: { keyDelayMs: 201 } }),
      "INVALID_CONFIG"
    );
  }
```

Add these cases near the BLE connection tests:

```js
  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect({ config: { keyDelayMs: 12 } });
    assert.deepEqual(fake.controlChar.writes[0], [1, 3, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(aiDevice.getConfig(), { keyDelayMs: 12 });
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
    fake.controlChar.writeError = new Error("config write failed");
    await assertRejectsWithCode(() => aiDevice.setConfig({ keyDelayMs: 11 }), "BLE_WRITE_FAILED");
    assert.deepEqual(aiDevice.getConfig(), { keyDelayMs: 20 });
  }
```

- [ ] **Step 3: Run SDK tests to verify failure**

Run:

```sh
npm --prefix sdk run test:sdk
```

Expected: FAIL because `CONTROL_CONFIG`, `encodeConfigFrame`, `assertConfig`, `getConfig`, `setConfig`, and connect config options are not implemented.

- [ ] **Step 4: Add SDK constants and config type**

In `sdk/src/constants.ts`, add:

```ts
export const CONTROL_CONFIG = 3;
export const DEFAULT_KEY_DELAY_MS = 20;
export const MIN_KEY_DELAY_MS = 1;
export const MAX_KEY_DELAY_MS = 200;
```

In `sdk/src/types.ts`, add:

```ts
export interface RemoteInputConfig {
  keyDelayMs: number;
}
```

- [ ] **Step 5: Add CONFIG encoding and validation**

In `sdk/src/protocol.ts`, import the new constants and `RemoteInputConfig`:

```ts
  CONTROL_CONFIG,
  DEFAULT_KEY_DELAY_MS,
  MAX_KEY_DELAY_MS,
  MIN_KEY_DELAY_MS,
```

```ts
import type { RemoteInputConfig, RemoteInputStatus } from "./types";
```

Add these functions after `encodeControlFrame()`:

```ts
export function assertConfig(config: RemoteInputConfig): void {
  if (
    !config ||
    !Number.isInteger(config.keyDelayMs) ||
    config.keyDelayMs < MIN_KEY_DELAY_MS ||
    config.keyDelayMs > MAX_KEY_DELAY_MS
  ) {
    throw new RemoteInputError(
      "INVALID_CONFIG",
      `keyDelayMs must be an integer from ${MIN_KEY_DELAY_MS} to ${MAX_KEY_DELAY_MS}`,
    );
  }
}

export function encodeConfigFrame(config: RemoteInputConfig): Uint8Array {
  assertConfig(config);
  const frame = new ArrayBuffer(12);
  const view = new DataView(frame);
  view.setUint8(0, VERSION);
  view.setUint8(1, CONTROL_CONFIG);
  view.setUint16(2, 0, true);
  view.setUint16(4, config.keyDelayMs, true);
  view.setUint32(6, 0, true);
  view.setUint16(10, 0, true);
  return new Uint8Array(frame);
}
```

Extend the exported `constants` object with:

```ts
  CONTROL_CONFIG,
  DEFAULT_KEY_DELAY_MS,
  MIN_KEY_DELAY_MS,
  MAX_KEY_DELAY_MS,
```

- [ ] **Step 6: Add RemoteInputClient config cache and methods**

In `sdk/src/device.ts`, import config helpers and type:

```ts
import { DEFAULT_KEY_DELAY_MS } from "./constants";
import { assertConfig, createDataFrames, decodeStatusFrame, encodeConfigFrame, encodeControlFrame } from "./protocol";
import type { PendingTask, RemoteInputConfig, RemoteInputStatus } from "./types";
```

Change the class fields and constructor:

```ts
  private config: RemoteInputConfig;

  constructor(transport: RemoteInputTransport, initialConfig: RemoteInputConfig = { keyDelayMs: DEFAULT_KEY_DELAY_MS }) {
    assertConfig(initialConfig);
    this.transport = transport;
    this.config = { ...initialConfig };
    this.onDisconnected = this.onDisconnected.bind(this);
    this.onStatusChanged = this.onStatusChanged.bind(this);
    this.transport.onDisconnect(this.onDisconnected);
    this.transport.onStatus(this.onStatusChanged);
  }
```

Add public methods after `connected`:

```ts
  getConfig(): RemoteInputConfig {
    return { ...this.config };
  }

  async setConfig(config: RemoteInputConfig): Promise<void> {
    if (!this.connected) {
      throw new RemoteInputError("NOT_CONNECTED", "Device is not connected");
    }
    assertConfig(config);
    try {
      await this.transport.writeControl(encodeConfigFrame(config));
      this.config = { ...config };
    } catch (error) {
      throw new RemoteInputError(this.writeErrorCode(), getErrorMessage(error, "Transport write failed"), error);
    }
  }
```

- [ ] **Step 7: Add BLE connect options**

In `sdk/src/transport/ble.ts`, import `RemoteInputConfig`:

```ts
  RemoteInputConfig,
```

Add:

```ts
export interface ConnectBleOptions {
  config?: RemoteInputConfig;
}
```

Change the function signature:

```ts
export async function connectBle(options: ConnectBleOptions = {}): Promise<RemoteInputClient> {
```

At the end of the successful connection block, replace `return new RemoteInputClient(transport);` with:

```ts
    const client = new RemoteInputClient(transport);
    if (options.config) {
      await client.setConfig(options.config);
    }
    return client;
```

- [ ] **Step 8: Add WebSocket connect options**

In `sdk/src/transport/ws.ts`, import `RemoteInputConfig`:

```ts
import type { RemoteInputConfig, RemoteWebSocket, RemoteWebSocketConstructor } from "../types";
```

Extend `ConnectWsOptions`:

```ts
export interface ConnectWsOptions {
  initialStatusTimeoutMs?: number;
  config?: RemoteInputConfig;
}
```

In `handleInitialMessage`, replace `resolve(new RemoteInputClient(new WsTransport(socket, WebSocketCtor, initialStatus)));` with:

```ts
      const transport = new WsTransport(socket, WebSocketCtor, initialStatus);
      const client = new RemoteInputClient(transport);
      if (options.config) {
        client.setConfig(options.config).then(
          () => resolve(client),
          (error) => {
            void transport.disconnect();
            reject(error);
          },
        );
        return;
      }
      resolve(client);
```

- [ ] **Step 9: Export the config type**

Inspect `sdk/src/index.ts`. If it already exports public types, add:

```ts
export type { RemoteInputConfig } from "./types";
```

If it does not currently export any types, still add the line so TypeScript consumers can import the config interface from the package entry point.

- [ ] **Step 10: Run SDK tests to verify pass**

Run:

```sh
npm --prefix sdk run test:sdk
```

Expected: PASS with `sdk protocol tests passed`.

- [ ] **Step 11: Commit SDK config API**

Run:

```sh
git add sdk/src/constants.ts sdk/src/types.ts sdk/src/protocol.ts sdk/src/device.ts sdk/src/transport/ble.ts sdk/src/transport/ws.ts sdk/src/index.ts sdk/tests/sdk-protocol.test.js
git commit -m "feat: add sdk runtime config api"
```

---

### Task 2: Firmware CONFIG Frame Parsing and Runtime Config Holder

**Files:**
- Modify: `firmware/components/remote_input_core/include/remote_input_protocol.h`
- Modify: `firmware/components/remote_input_core/remote_input_protocol.c`
- Modify: `firmware/components/remote_input_core/include/remote_input_receiver.h`
- Modify: `firmware/components/remote_input_core/include/remote_input_engine.h`
- Modify: `firmware/components/remote_input_core/remote_input_engine.c`
- Create: `firmware/components/remote_input_device/include/remote_input_config.h`
- Create: `firmware/components/remote_input_device/remote_input_config.c`
- Modify: `firmware/components/remote_input_device/CMakeLists.txt`
- Modify: `firmware/components/remote_input_device/remote_input_ble.c`
- Modify: `firmware/components/remote_input_device/remote_input_ws.c`
- Modify: `firmware/components/remote_input_device/remote_input_service.c`

**Interfaces:**
- Consumes: `CONFIG` bytes produced by Task 1.
- Produces: `remote_input_config_frame_t`, `remote_input_parse_config_frame()`, `remote_input_config_t`, `remote_input_config_init()`, `remote_input_config_default()`, `remote_input_config_get()`, `remote_input_config_update()`, `remote_input_engine_handle_config()`, `remote_input_receiver_config_cb_t`.

- [ ] **Step 1: Add protocol constants and config frame type**

In `firmware/components/remote_input_core/include/remote_input_protocol.h`, add:

```c
#define REMOTE_INPUT_KEY_DELAY_DEFAULT_MS 20
#define REMOTE_INPUT_KEY_DELAY_MIN_MS 1
#define REMOTE_INPUT_KEY_DELAY_MAX_MS 200
```

Extend `remote_input_frame_type_t`:

```c
    REMOTE_INPUT_CONTROL_CONFIG = 3,
```

Add:

```c
typedef struct {
    uint16_t key_delay_ms;
} remote_input_config_frame_t;
```

Add prototype:

```c
bool remote_input_parse_config_frame(const uint8_t *data, size_t len, remote_input_config_frame_t *out);
```

- [ ] **Step 2: Implement CONFIG parser**

In `firmware/components/remote_input_core/remote_input_protocol.c`, add after `remote_input_parse_control_frame()`:

```c
bool remote_input_parse_config_frame(const uint8_t *data, size_t len, remote_input_config_frame_t *out)
{
    if (data == NULL || out == NULL || len != REMOTE_INPUT_CONTROL_FRAME_LEN) {
        return false;
    }
    if (data[0] != REMOTE_INPUT_PROTOCOL_VERSION || data[1] != REMOTE_INPUT_CONTROL_CONFIG) {
        return false;
    }
    if (read_le16(&data[2]) != 0) {
        return false;
    }

    const uint16_t key_delay_ms = read_le16(&data[4]);
    if (key_delay_ms < REMOTE_INPUT_KEY_DELAY_MIN_MS || key_delay_ms > REMOTE_INPUT_KEY_DELAY_MAX_MS) {
        return false;
    }
    for (size_t i = 6; i < REMOTE_INPUT_CONTROL_FRAME_LEN; i += 1) {
        if (data[i] != 0) {
            return false;
        }
    }

    out->key_delay_ms = key_delay_ms;
    return true;
}
```

- [ ] **Step 3: Add receiver config callback**

In `firmware/components/remote_input_core/include/remote_input_receiver.h`, add:

```c
typedef void (*remote_input_receiver_config_cb_t)(const remote_input_config_frame_t *frame, void *ctx);
```

Extend `remote_input_receiver_callbacks_t`:

```c
    remote_input_receiver_config_cb_t on_config;
```

- [ ] **Step 4: Add engine config callback and handler**

In `firmware/components/remote_input_core/include/remote_input_engine.h`, add:

```c
typedef remote_input_error_t (*remote_input_engine_config_cb_t)(const remote_input_config_frame_t *frame, void *ctx);
```

Extend `remote_input_engine_callbacks_t`:

```c
    remote_input_engine_config_cb_t apply_config;
```

Add prototype:

```c
void remote_input_engine_handle_config(remote_input_engine_t *engine,
                                       const remote_input_config_frame_t *frame);
```

In `firmware/components/remote_input_core/remote_input_engine.c`, add:

```c
static remote_input_error_t apply_config(remote_input_engine_t *engine,
                                         const remote_input_config_frame_t *frame)
{
    if (engine == NULL || engine->callbacks.apply_config == NULL) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }

    return engine->callbacks.apply_config(frame, engine->callbacks.ctx);
}
```

Add public handler before `remote_input_engine_handle_data()`:

```c
void remote_input_engine_handle_config(remote_input_engine_t *engine,
                                       const remote_input_config_frame_t *frame)
{
    if (engine == NULL || frame == NULL) {
        notify_status(engine, REMOTE_INPUT_STATE_ERROR, 0, REMOTE_INPUT_ERR_INVALID_COMMAND, 0, 0);
        return;
    }

    remote_input_error_t err = apply_config(engine, frame);
    if (err != REMOTE_INPUT_ERR_OK) {
        notify_status(engine, REMOTE_INPUT_STATE_ERROR, 0, err, 0, 0);
    }
}
```

- [ ] **Step 5: Create runtime config API**

Create `firmware/components/remote_input_device/include/remote_input_config.h`:

```c
#pragma once

#include <stdint.h>

#include "remote_input_protocol.h"
#include "remote_input_status.h"

typedef struct {
    uint16_t key_delay_ms;
} remote_input_config_t;

void remote_input_config_init(void);
remote_input_config_t remote_input_config_default(void);
remote_input_config_t remote_input_config_get(void);
remote_input_error_t remote_input_config_update(const remote_input_config_frame_t *frame);
```

Create `firmware/components/remote_input_device/remote_input_config.c`:

```c
#include "remote_input_config.h"

#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static remote_input_config_t s_config;
static portMUX_TYPE s_config_lock = portMUX_INITIALIZER_UNLOCKED;

remote_input_config_t remote_input_config_default(void)
{
    return (remote_input_config_t) {
        .key_delay_ms = REMOTE_INPUT_KEY_DELAY_DEFAULT_MS,
    };
}

void remote_input_config_init(void)
{
    portENTER_CRITICAL(&s_config_lock);
    s_config = remote_input_config_default();
    portEXIT_CRITICAL(&s_config_lock);
}

remote_input_config_t remote_input_config_get(void)
{
    remote_input_config_t config;

    portENTER_CRITICAL(&s_config_lock);
    config = s_config;
    portEXIT_CRITICAL(&s_config_lock);

    return config;
}

remote_input_error_t remote_input_config_update(const remote_input_config_frame_t *frame)
{
    if (frame == NULL ||
        frame->key_delay_ms < REMOTE_INPUT_KEY_DELAY_MIN_MS ||
        frame->key_delay_ms > REMOTE_INPUT_KEY_DELAY_MAX_MS) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }

    portENTER_CRITICAL(&s_config_lock);
    s_config.key_delay_ms = frame->key_delay_ms;
    portEXIT_CRITICAL(&s_config_lock);

    return REMOTE_INPUT_ERR_OK;
}
```

Modify `firmware/components/remote_input_device/CMakeLists.txt` to include `remote_input_config.c` in the component sources. Use the existing source list style in that file and add exactly:

```cmake
    remote_input_config.c
```

- [ ] **Step 6: Route CONFIG in BLE receiver**

In `firmware/components/remote_input_device/remote_input_ble.c`, update `control_access_cb()` after copying the buffer and before parsing START/COMMIT:

```c
    const uint8_t type = len > 1 ? buf[1] : 0;
    if (type == REMOTE_INPUT_CONTROL_CONFIG) {
        remote_input_config_frame_t frame;
        if (!remote_input_parse_config_frame(buf, len, &frame)) {
            notify_receiver_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        if (s_callbacks.on_config != NULL) {
            s_callbacks.on_config(&frame, s_callbacks.ctx);
        }
        return 0;
    }
```

Leave existing START/COMMIT parsing below this block.

- [ ] **Step 7: Route CONFIG in WebSocket receiver**

In `firmware/components/remote_input_device/remote_input_ws.c`, update `handle_binary_frame()` so the first 12-byte Control-frame branch handles `CONFIG` separately:

```c
    if (len == REMOTE_INPUT_CONTROL_FRAME_LEN && type == REMOTE_INPUT_CONTROL_CONFIG) {
        remote_input_config_frame_t frame;
        if (!remote_input_parse_config_frame(payload, len, &frame)) {
            notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
            return;
        }
        if (s_callbacks.on_config != NULL) {
            s_callbacks.on_config(&frame, s_callbacks.ctx);
        }
        return;
    }
```

Keep the existing START/COMMIT branch after this new branch.

- [ ] **Step 8: Apply config in service through engine**

In `firmware/components/remote_input_device/remote_input_service.c`, include:

```c
#include "remote_input_config.h"
```

Add callback:

```c
static remote_input_error_t apply_config_cb(const remote_input_config_frame_t *frame, void *ctx)
{
    (void)ctx;

    return remote_input_config_update(frame);
}
```

Add receiver callback:

```c
static void on_config(const remote_input_config_frame_t *frame, void *ctx)
{
    (void)ctx;

    remote_input_engine_handle_config(&s_engine, frame);
}
```

In `remote_input_service_init()`, call after `remote_input_status_init();`:

```c
    remote_input_config_init();
```

In `engine_callbacks`, add:

```c
        .apply_config = apply_config_cb,
```

In receiver `callbacks`, add:

```c
        .on_config = on_config,
```

- [ ] **Step 9: Run firmware build to catch integration errors**

Run:

```sh
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS. If it fails, fix compiler errors in the touched firmware files only.

- [ ] **Step 10: Commit firmware config parsing**

Run:

```sh
git add firmware/components/remote_input_core/include/remote_input_protocol.h firmware/components/remote_input_core/remote_input_protocol.c firmware/components/remote_input_core/include/remote_input_receiver.h firmware/components/remote_input_core/include/remote_input_engine.h firmware/components/remote_input_core/remote_input_engine.c firmware/components/remote_input_device/include/remote_input_config.h firmware/components/remote_input_device/remote_input_config.c firmware/components/remote_input_device/CMakeLists.txt firmware/components/remote_input_device/remote_input_ble.c firmware/components/remote_input_device/remote_input_ws.c firmware/components/remote_input_device/remote_input_service.c
git commit -m "feat: parse runtime config frames"
```

---

### Task 3: Firmware Writer Snapshot and HID Delay Application

**Files:**
- Modify: `firmware/components/remote_input_core/include/remote_input_writer.h`
- Modify: `firmware/components/remote_input_device/include/remote_input_writer_runner.h`
- Modify: `firmware/components/remote_input_device/remote_input_writer_runner.c`
- Modify: `firmware/components/remote_input_device/include/remote_input_hid.h`
- Modify: `firmware/components/remote_input_device/remote_input_hid.c`
- Modify: `firmware/components/remote_input_device/remote_input_service.c`

**Interfaces:**
- Consumes: `remote_input_config_t remote_input_config_get(void)` from Task 2.
- Produces: writer API `remote_input_error_t (*write_text)(const uint8_t *bytes, size_t len, const remote_input_config_t *config, void *ctx)` and submit API `remote_input_writer_runner_submit(uint16_t task_id, const uint8_t *bytes, size_t len, remote_input_config_t config)`.

- [ ] **Step 1: Extend writer interface**

In `firmware/components/remote_input_core/include/remote_input_writer.h`, include config:

```c
#include "remote_input_config.h"
```

Change the function pointer to:

```c
    remote_input_error_t (*write_text)(const uint8_t *bytes,
                                       size_t len,
                                       const remote_input_config_t *config,
                                       void *ctx);
```

- [ ] **Step 2: Extend writer runner submit interface**

In `firmware/components/remote_input_device/include/remote_input_writer_runner.h`, include config:

```c
#include "remote_input_config.h"
```

Change submit prototype to:

```c
remote_input_error_t remote_input_writer_runner_submit(uint16_t task_id,
                                                       const uint8_t *bytes,
                                                       size_t len,
                                                       remote_input_config_t config);
```

- [ ] **Step 3: Store config snapshot in writer jobs**

In `firmware/components/remote_input_device/remote_input_writer_runner.c`, add to `writer_job_t`:

```c
    remote_input_config_t config;
```

Change `write_job()` to:

```c
static remote_input_error_t write_job(const writer_job_t *job)
{
    if (job == NULL || s_writer == NULL || s_writer->write_text == NULL) {
        return REMOTE_INPUT_ERR_HID_INPUT_FAILED;
    }

    return s_writer->write_text(job->bytes, job->len, &job->config, s_writer->ctx);
}
```

Change `remote_input_writer_runner_submit()` signature and set the snapshot:

```c
remote_input_error_t remote_input_writer_runner_submit(uint16_t task_id,
                                                       const uint8_t *bytes,
                                                       size_t len,
                                                       remote_input_config_t config)
```

Before copying bytes, add:

```c
    if (config.key_delay_ms < REMOTE_INPUT_KEY_DELAY_MIN_MS ||
        config.key_delay_ms > REMOTE_INPUT_KEY_DELAY_MAX_MS) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }
```

After `s_pending_job.len = len;`, add:

```c
    s_pending_job.config = config;
```

- [ ] **Step 4: Pass current config from service at submit time**

In `firmware/components/remote_input_device/remote_input_service.c`, change `submit_text_cb()` body to:

```c
    remote_input_config_t config = remote_input_config_get();
    return remote_input_writer_runner_submit(task_id, bytes, len, config);
```

- [ ] **Step 5: Make HID report delay configurable**

In `firmware/components/remote_input_device/include/remote_input_hid.h`, include config:

```c
#include "remote_input_config.h"
```

Change write prototype:

```c
remote_input_error_t remote_input_hid_write_text(const uint8_t *bytes,
                                                 size_t len,
                                                 const remote_input_config_t *config,
                                                 void *ctx);
```

In `firmware/components/remote_input_device/remote_input_hid.c`, change `hid_write_context_t`:

```c
typedef struct {
    remote_input_error_t error;
    uint16_t key_delay_ms;
} hid_write_context_t;
```

Change `send_report()` signature and delay:

```c
static esp_err_t send_report(uint8_t modifier, uint8_t const keycode[6], uint16_t key_delay_ms)
{
    if (!tud_hid_ready()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!tud_hid_keyboard_report(REPORT_ID_KEYBOARD, modifier, keycode)) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    vTaskDelay(pdMS_TO_TICKS(key_delay_ms));
    return ESP_OK;
}
```

Change `release_all_keys()` signature and delay uses:

```c
static esp_err_t release_all_keys(uint16_t key_delay_ms)
```

Replace each `vTaskDelay(pdMS_TO_TICKS(REMOTE_INPUT_HID_DELAY_MS));` in `release_all_keys()` with:

```c
            vTaskDelay(pdMS_TO_TICKS(key_delay_ms));
```

and:

```c
        vTaskDelay(pdMS_TO_TICKS(key_delay_ms));
```

Change `send_alt_modified_key()`:

```c
static esp_err_t send_alt_modified_key(uint8_t keycode, uint16_t key_delay_ms)
{
    const uint8_t keys[6] = {keycode, 0, 0, 0, 0, 0};
    const uint8_t no_keys[6] = {0};

    ESP_RETURN_ON_ERROR(send_report(KEYBOARD_MODIFIER_LEFTALT, keys, key_delay_ms), TAG, "hid key press failed");
    ESP_RETURN_ON_ERROR(send_report(KEYBOARD_MODIFIER_LEFTALT, no_keys, key_delay_ms), TAG, "hid key release failed");
    return ESP_OK;
}
```

Change `remote_input_hid_type_codepoint()` signature:

```c
esp_err_t remote_input_hid_type_codepoint(uint32_t codepoint, uint16_t key_delay_ms)
```

Within that function:

```c
    esp_err_t ret = send_report(KEYBOARD_MODIFIER_LEFTALT, no_keys, key_delay_ms);
```

```c
        (void)release_all_keys(key_delay_ms);
```

```c
    ret = send_alt_modified_key(HID_KEY_KEYPAD_ADD, key_delay_ms);
```

```c
        (void)release_all_keys(key_delay_ms);
```

```c
        ret = send_alt_modified_key(keycode, key_delay_ms);
```

```c
            (void)release_all_keys(key_delay_ms);
```

and final return:

```c
    return release_all_keys(key_delay_ms);
```

In `type_codepoint_cb()`, call:

```c
    esp_err_t err = remote_input_hid_type_codepoint(codepoint, write_ctx->key_delay_ms);
```

Change `remote_input_hid_write_text()` signature and initialization:

```c
remote_input_error_t remote_input_hid_write_text(const uint8_t *bytes,
                                                 size_t len,
                                                 const remote_input_config_t *config,
                                                 void *ctx)
```

Before the UTF-8 validation, add:

```c
    const uint16_t key_delay_ms = config != NULL ? config->key_delay_ms : REMOTE_INPUT_KEY_DELAY_DEFAULT_MS;
    if (key_delay_ms < REMOTE_INPUT_KEY_DELAY_MIN_MS || key_delay_ms > REMOTE_INPUT_KEY_DELAY_MAX_MS) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }
```

Initialize write context:

```c
    hid_write_context_t write_ctx = {
        .error = REMOTE_INPUT_ERR_OK,
        .key_delay_ms = key_delay_ms,
    };
```

- [ ] **Step 6: Run firmware build to verify writer integration**

Run:

```sh
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS. If it fails, fix signature mismatches in touched writer/HID files only.

- [ ] **Step 7: Commit writer config snapshot**

Run:

```sh
git add firmware/components/remote_input_core/include/remote_input_writer.h firmware/components/remote_input_device/include/remote_input_writer_runner.h firmware/components/remote_input_device/remote_input_writer_runner.c firmware/components/remote_input_device/include/remote_input_hid.h firmware/components/remote_input_device/remote_input_hid.c firmware/components/remote_input_device/remote_input_service.c
git commit -m "feat: apply runtime input delay"
```

---

### Task 4: Protocol Documentation and Full Verification

**Files:**
- Modify: `docs/remote-input-protocol.md`
- Verify: SDK and firmware builds

**Interfaces:**
- Consumes: final protocol/API/firmware behavior from Tasks 1-3.
- Produces: documented CONFIG frame and final verification evidence.

- [ ] **Step 1: Update protocol overview constants**

In `docs/remote-input-protocol.md`, in the basic limits table, update the Control row text from:

```markdown
| Control 帧长度 | `12` 字节 |
```

to:

```markdown
| Control 帧长度 | `12` 字节，适用于 START、COMMIT 和 CONFIG |
```

- [ ] **Step 2: Document CONFIG frame type**

In section `4. Control 帧`, update the introduction from:

```markdown
Control 帧固定为 12 字节。在 BLE 传输中，START 和 COMMIT 帧写入 Control 特征值；在 WebSocket 传输中，START 和 COMMIT 帧分别作为独立 binary message 发送。
```

to:

```markdown
Control 帧固定为 12 字节。在 BLE 传输中，START、COMMIT 和 CONFIG 帧写入 Control 特征值；在 WebSocket 传输中，START、COMMIT 和 CONFIG 帧分别作为独立 binary message 发送。
```

Extend the type table:

```markdown
| 3 | CONFIG | 更新设备运行时配置 |
```

After the START/COMMIT validation rules, add:

```markdown
CONFIG 帧格式：

| 偏移 | 长度 | 类型 | 字段 | 说明 |
| --- | ---: | --- | --- | --- |
| 0 | 1 | `uint8` | `version` | 必须为 `1` |
| 1 | 1 | `uint8` | `type` | 必须为 `3` |
| 2 | 2 | `uint16` | `flags` | 保留字段，必须为 `0` |
| 4 | 2 | `uint16` | `key_delay_ms` | HID report 之间的延迟，范围 `1..200` 毫秒 |
| 6 | 6 | bytes | `reserved` | 保留字段，必须全部为 `0` |

CONFIG 校验规则：

- `version` 必须为 `1`。
- `type` 必须为 CONFIG。
- `flags` 必须为 `0`。
- `key_delay_ms` 必须在 `1..200` 范围内。
- `reserved` 必须全部为 `0`。

CONFIG 只更新运行时配置，不写入 NVS。设备重启后恢复默认 `key_delay_ms = 20`。配置变更只影响后续输入任务；正在输入的任务继续使用任务提交时捕获的配置快照。
```

- [ ] **Step 3: Update normal flow with optional config**

In section `7. 正常发送流程`, insert before step 1:

```markdown
SDK 可以在连接后发送 CONFIG 帧更新运行时参数，例如 `key_delay_ms`。如果 SDK 不发送 CONFIG，设备使用默认 `20ms` 输入延迟。
```

- [ ] **Step 4: Run SDK verification**

Run:

```sh
npm --prefix sdk run test:sdk
```

Expected: PASS with `sdk protocol tests passed`.

- [ ] **Step 5: Run firmware verification**

Run:

```sh
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS and `firmware/build/remote_input.bin` is generated.

- [ ] **Step 6: Check git status for unintended files**

Run:

```sh
git status --short
```

Expected: only intended source, test, docs, and possibly `firmware/dependencies.lock` if ESP-IDF dependency solving updated it. Do not commit `firmware/build`.

- [ ] **Step 7: Commit protocol docs and final verification updates**

Run:

```sh
git add docs/remote-input-protocol.md
git commit -m "docs: describe runtime config frame"
```

If `firmware/dependencies.lock` changed because ESP-IDF updated the selected IDF version metadata, inspect it with `git diff -- firmware/dependencies.lock`. Commit it only if the diff is limited to expected ESP-IDF dependency metadata for the active eim version.

---

## Plan Self-Review

- Spec coverage: The plan covers runtime-only config, `keyDelayMs`, range/default, CONFIG frame, SDK API, BLE/WebSocket connect-time config, dynamic update semantics, firmware runtime holder, writer snapshot, docs, SDK tests, firmware build, and hardware validation note.
- Placeholder scan: No task uses TBD/TODO/fill-in language. Each code-changing step names exact files and concrete code or exact edits.
- Type consistency: `RemoteInputConfig`, `remote_input_config_t`, `remote_input_config_frame_t`, `keyDelayMs`, and `key_delay_ms` names are consistent across SDK, protocol, firmware, and docs.
