# Large Text Protocol v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Remote Input to protocol v2 with 128 KB text tasks and 180-byte data chunks across BLE, WebSocket, firmware, SDK, and docs.

**Architecture:** Keep `remote_input_core` transport-neutral while changing protocol constants, parsing, dynamic receive buffers, and writer job ownership. Refactor the SDK so protocol frame generation remains shared and BLE/WebSocket transports only perform raw writes, with BLE DATA preferring write without response.

**Tech Stack:** ESP-IDF 6.0.2, NimBLE, ESP HTTP Server WebSocket, TypeScript ES modules, Vite IIFE build, Node `assert` tests.

## Global Constraints

- Protocol version is `2`.
- Maximum UTF-8 text length is `128 * 1024` bytes.
- Data frame payload size is fixed at `180` bytes.
- BLE and WebSocket use the same START, DATA, COMMIT, CONFIG, and STATUS frame formats.
- Version 1 frames are rejected.
- SDK rejects text over 128 KB before sending.
- Firmware also rejects tasks over 128 KB.
- No version negotiation.
- No backward compatibility with protocol v1.
- No stream-to-HID execution while data is still arriving.
- No disk, flash, PSRAM, or filesystem buffering.
- Do not run `idf.py flash`, `idf.py monitor`, or combined flash/monitor commands in this environment.

---

## File Structure

- `sdk/src/constants.ts`: protocol constants only.
- `sdk/src/protocol.ts`: frame encoding, data chunk generation, status decoding, config/text validation.
- `sdk/src/types.ts`: Web Bluetooth and WebSocket structural types.
- `sdk/src/transport/types.ts`: transport interface used by `RemoteInputClient`.
- `sdk/src/transport/ble.ts`: BLE connection and characteristic writes.
- `sdk/src/transport/ws.ts`: WebSocket connection and binary frame writes.
- `sdk/src/device.ts`: `RemoteInputClient` task lifecycle and shared START/DATA/COMMIT pump.
- `sdk/tests/sdk-protocol.test.js`: SDK protocol and flow tests.
- `firmware/components/remote_input_core/include/remote_input_protocol.h`: firmware protocol constants and frame structs.
- `firmware/components/remote_input_core/remote_input_protocol.c`: firmware frame parsing.
- `firmware/components/remote_input_core/include/remote_input_task.h`: dynamic receive task state.
- `firmware/components/remote_input_core/remote_input_task.c`: START/DATA/COMMIT receive buffer ownership.
- `firmware/components/remote_input_device/remote_input_writer_runner.c`: dynamic writer job allocation and freeing.
- `firmware/components/remote_input_device/remote_input_ble.c`: BLE frame size, Data characteristic flags, connection parameter and MTU logging.
- `firmware/components/remote_input_device/remote_input_ws.c`: WebSocket frame size limit.
- `docs/remote-input-protocol.md`: v2 protocol documentation.

---

### Task 1: SDK v2 Protocol Tests

**Files:**
- Modify: `sdk/tests/sdk-protocol.test.js`

**Interfaces:**
- Consumes: existing `_internals.constants`, `_internals.encodeControlFrame`, `_internals.encodeConfigFrame`, `_internals.createDataFrames`, `_internals.decodeStatusFrame`, `_internals.assertTextSize`.
- Produces: failing tests that define v2 SDK behavior.

- [ ] **Step 1: Update constant expectations**

Change the constants block near the top of `sdk/tests/sdk-protocol.test.js` to:

```js
{
  const { constants } = internals;
  assert.equal(constants.VERSION, 2);
  assert.equal(constants.DATA_FRAME, 16);
  assert.equal(constants.DATA_PAYLOAD_BYTES, 180);
  assert.equal(constants.MAX_TEXT_BYTES, 128 * 1024);
}
```

- [ ] **Step 2: Update control/config frame expected bytes**

Change expected v1 version byte `1` to v2 version byte `2` in the protocol frame tests:

```js
{
  const frame = internals.encodeControlFrame(1, 7, 16, 2);
  assert.equal(frame.byteLength, 12);
  assert.deepEqual(Array.from(frame), [2, 1, 7, 0, 16, 0, 0, 0, 2, 0, 0, 0]);
}

{
  const frame = internals.encodeConfigFrame({ keyDelayMs: 10 });
  assert.equal(frame.byteLength, 12);
  assert.deepEqual(Array.from(frame), [2, 3, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
}
```

- [ ] **Step 3: Replace small and multi-chunk DATA tests**

Use this block for the one-frame data test:

```js
{
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const chunks = internals.createDataFrames(9, bytes);
  assert.equal(chunks.length, 1);
  assert.deepEqual(Array.from(chunks[0]), [2, 16, 9, 0, 0, 0, 1, 0, 1, 2, 3, 4, 5]);
}
```

Use this block for 180-byte chunk boundaries:

```js
{
  const bytes = new Uint8Array(361);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index & 0xff;
  }
  const chunks = internals.createDataFrames(3, bytes);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].byteLength, 188);
  assert.equal(chunks[1].byteLength, 188);
  assert.equal(chunks[2].byteLength, 9);
  assert.deepEqual(Array.from(chunks[0].slice(0, 8)), [2, 16, 3, 0, 0, 0, 3, 0]);
  assert.deepEqual(Array.from(chunks[1].slice(0, 8)), [2, 16, 3, 0, 1, 0, 3, 0]);
  assert.deepEqual(Array.from(chunks[2]), [2, 16, 3, 0, 2, 0, 3, 0, 104]);
}
```

- [ ] **Step 4: Update text size tests**

Replace the 16 KB size tests with:

```js
{
  const oversized = new Uint8Array((128 * 1024) + 1);
  assert.throws(
    () => internals.assertTextSize(oversized),
    /TEXT_TOO_LARGE/
  );
}

{
  const valid = new Uint8Array(128 * 1024);
  assert.equal(internals.assertTextSize(valid), undefined);
}
```

- [ ] **Step 5: Add v1 status rejection test**

Add this after the valid status decode test:

```js
{
  const frame = new Uint8Array([1, 2, 12, 0, 0, 0, 0, 4, 0, 0, 0, 16, 0, 0]);
  assert.throws(
    () => internals.decodeStatusFrame(frame.buffer),
    /INVALID_STATUS_FRAME/
  );
}
```

- [ ] **Step 6: Run SDK test and verify it fails**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: FAIL. At minimum, assertions should show `1 !== 2`, `12 !== 180`, or frame byte mismatches.

- [ ] **Step 7: Commit failing SDK protocol tests**

```bash
git add sdk/tests/sdk-protocol.test.js
git commit -m "test: define protocol v2 sdk framing"
```

---

### Task 2: SDK v2 Constants and Frame Encoding

**Files:**
- Modify: `sdk/src/constants.ts`
- Modify: `sdk/src/protocol.ts`

**Interfaces:**
- Consumes: tests from Task 1.
- Produces: `VERSION = 2`, `DATA_PAYLOAD_BYTES = 180`, `MAX_TEXT_BYTES = 128 * 1024`, unchanged exported protocol function names.

- [ ] **Step 1: Update protocol constants**

In `sdk/src/constants.ts`, set:

```ts
export const VERSION = 2;
export const CONTROL_START = 1;
export const CONTROL_COMMIT = 2;
export const CONTROL_CONFIG = 3;
export const DATA_FRAME = 16;
export const MAX_TEXT_BYTES = 128 * 1024;
export const DATA_PAYLOAD_BYTES = 180;
```

Keep the UUIDs, key delay constants, and states unchanged.

- [ ] **Step 2: Keep protocol functions using constants**

Inspect `sdk/src/protocol.ts` and ensure `encodeControlFrame`, `encodeConfigFrame`, `createDataFrames`, `decodeStatusFrame`, and `assertTextSize` use imported `VERSION`, `DATA_PAYLOAD_BYTES`, and `MAX_TEXT_BYTES`; do not hardcode `2`, `180`, or `128 * 1024` inside function bodies.

- [ ] **Step 3: Run SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: some tests may still FAIL because BLE/WS flow expectations still contain v1 bytes.

- [ ] **Step 4: Commit constants implementation**

```bash
git add sdk/src/constants.ts sdk/src/protocol.ts
git commit -m "feat: update sdk protocol constants to v2"
```

---

### Task 3: SDK Transport Refactor and BLE Write Without Response

**Files:**
- Modify: `sdk/src/types.ts`
- Modify: `sdk/src/transport/ble.ts`
- Modify: `sdk/tests/sdk-protocol.test.js`

**Interfaces:**
- Consumes: `RemoteBluetoothCharacteristic.writeValueWithResponse(value)`.
- Produces: optional `RemoteBluetoothCharacteristic.writeValueWithoutResponse(value)` and BLE DATA write preference.

- [ ] **Step 1: Extend fake characteristic test helper**

In `FakeCharacteristic` inside `sdk/tests/sdk-protocol.test.js`, add fields in the constructor:

```js
this.writeWithoutResponseCalls = [];
this.writeWithoutResponseError = null;
this.supportsWriteWithoutResponse = false;
```

Add this method to `FakeCharacteristic`:

```js
async writeValueWithoutResponse(value) {
  if (!this.supportsWriteWithoutResponse) {
    throw new Error("write without response not supported");
  }
  if (this.writeWithoutResponseError) throw this.writeWithoutResponseError;
  this.writeWithoutResponseCalls.push(Array.from(value));
  if (this.afterWrite) await this.afterWrite(value, this.writes.length + this.writeWithoutResponseCalls.length);
  if (this.writeNeverResolves) {
    return new Promise(() => {});
  }
}
```

- [ ] **Step 2: Update BLE hello flow expected v2 bytes**

In the `"hello"` BLE flow block, change expected frames to:

```js
assert.deepEqual(fake.controlChar.writes[0], [2, 1, 1, 0, 5, 0, 0, 0, 1, 0, 0, 0]);
assert.deepEqual(fake.dataChar.writes[0], [2, 16, 1, 0, 0, 0, 1, 0, 104, 101, 108, 108, 111]);
assert.deepEqual(fake.controlChar.writes[1], [2, 2, 1, 0, 5, 0, 0, 0, 1, 0, 0, 0]);
```

- [ ] **Step 3: Add BLE write without response preference test**

Add this block after the BLE hello flow test:

```js
{
  const fake = createFakeBluetooth();
  fake.dataChar.supportsWriteWithoutResponse = true;
  const aiDevice = await RemoteInput.connect();
  const completion = aiDevice.typeText("fast");
  await flushMicrotasks();

  assert.deepEqual(fake.controlChar.writes[0], [2, 1, 1, 0, 4, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(fake.dataChar.writeWithoutResponseCalls[0], [2, 16, 1, 0, 0, 0, 1, 0, 102, 97, 115, 116]);
  assert.equal(fake.dataChar.writes.length, 0);
  assert.deepEqual(fake.controlChar.writes[1], [2, 2, 1, 0, 4, 0, 0, 0, 1, 0, 0, 0]);

  fake.statusChar.emitStatus(createStatusFrame(3, 1, 0, 4, 4));
  await completion;
}
```

- [ ] **Step 4: Update other SDK flow expected bytes**

Replace remaining hardcoded v1 protocol byte expectations in `sdk/tests/sdk-protocol.test.js`:

```js
assert.deepEqual(socket.sent[0], [2, 3, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
assert.deepEqual(socket.sent[0], [2, 3, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0]);
assert.deepEqual(socket.sent[0], [2, 1, 1, 0, 2, 0, 0, 0, 1, 0, 0, 0]);
assert.deepEqual(socket.sent[1], [2, 16, 1, 0, 0, 0, 1, 0, 119, 115]);
assert.deepEqual(socket.sent[2], [2, 2, 1, 0, 2, 0, 0, 0, 1, 0, 0, 0]);
assert.deepEqual(fake.controlChar.writes[0], [2, 3, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0]);
assert.deepEqual(fake.controlChar.writes[0].slice(0, 4), [2, 1, 255, 255]);
```

- [ ] **Step 5: Run SDK test and verify it fails on missing implementation**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: FAIL if `writeValueWithoutResponse` is not used yet, specifically the new `writeWithoutResponseCalls` assertion should fail.

- [ ] **Step 6: Add optional type field**

In `sdk/src/types.ts`, update `RemoteBluetoothCharacteristic`:

```ts
export interface RemoteBluetoothCharacteristic extends EventTarget {
  writeValueWithResponse(value: Uint8Array): Promise<void>;
  writeValueWithoutResponse?: (value: Uint8Array) => Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<RemoteBluetoothCharacteristic>;
  stopNotifications?: () => Promise<RemoteBluetoothCharacteristic>;
}
```

- [ ] **Step 7: Use write without response for BLE data**

In `sdk/src/transport/ble.ts`, change `writeData` to:

```ts
writeData(frame: Uint8Array): Promise<void> {
  if (this.dataChar.writeValueWithoutResponse) {
    return this.dataChar.writeValueWithoutResponse(frame);
  }
  return this.dataChar.writeValueWithResponse(frame);
}
```

Keep `writeControl` as:

```ts
writeControl(frame: Uint8Array): Promise<void> {
  return this.controlChar.writeValueWithResponse(frame);
}
```

- [ ] **Step 8: Run SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS.

- [ ] **Step 9: Commit SDK BLE transport refactor**

```bash
git add sdk/src/types.ts sdk/src/transport/ble.ts sdk/tests/sdk-protocol.test.js
git commit -m "feat: prefer ble data writes without response"
```

---

### Task 4: Firmware Protocol Constants and Parsers

**Files:**
- Modify: `firmware/components/remote_input_core/include/remote_input_protocol.h`
- Modify: `firmware/components/remote_input_core/remote_input_protocol.c`

**Interfaces:**
- Consumes: existing `remote_input_parse_control_frame`, `remote_input_parse_data_frame`, `remote_input_parse_config_frame` signatures.
- Produces: v2 parser behavior with 128 KB max and 180-byte data payload.

- [ ] **Step 1: Update firmware protocol constants**

In `remote_input_protocol.h`, set:

```c
#define REMOTE_INPUT_PROTOCOL_VERSION 2
#define REMOTE_INPUT_MAX_TEXT_BYTES (128 * 1024)
#define REMOTE_INPUT_DATA_PAYLOAD_BYTES 180
```

Keep:

```c
#define REMOTE_INPUT_CONTROL_FRAME_LEN 12
#define REMOTE_INPUT_DATA_FRAME_HEADER_LEN 8
#define REMOTE_INPUT_STATUS_FRAME_LEN 14
```

- [ ] **Step 2: Confirm parser uses constants**

Inspect `remote_input_protocol.c` and keep these checks constant-driven:

```c
if (total_bytes > REMOTE_INPUT_MAX_TEXT_BYTES) {
    return false;
}
```

```c
len > REMOTE_INPUT_DATA_FRAME_HEADER_LEN + REMOTE_INPUT_DATA_PAYLOAD_BYTES
```

No parser branch should accept protocol version `1`.

- [ ] **Step 3: Run firmware build**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: build may FAIL later due to static arrays sized from 128 KB if memory or compile warnings surface. If it passes, continue; dynamic memory changes still happen in Task 5.

- [ ] **Step 4: Commit firmware constants**

```bash
git add firmware/components/remote_input_core/include/remote_input_protocol.h firmware/components/remote_input_core/remote_input_protocol.c
git commit -m "feat: update firmware protocol constants to v2"
```

---

### Task 5: Firmware Dynamic Receive Task Buffer

**Files:**
- Modify: `firmware/components/remote_input_core/include/remote_input_task.h`
- Modify: `firmware/components/remote_input_core/remote_input_task.c`

**Interfaces:**
- Consumes: `remote_input_task_start`, `remote_input_task_add_chunk`, `remote_input_task_commit`, `remote_input_task_reset`.
- Produces: same public functions with dynamic `buffer` and `chunk_seen` ownership.

- [ ] **Step 1: Change task struct**

Replace `remote_input_task_buffer_t` in `remote_input_task.h` with:

```c
typedef struct {
    uint16_t task_id;
    uint32_t total_bytes;
    uint16_t total_chunks;
    uint32_t received_bytes;
    uint16_t received_chunks;
    remote_input_config_t config;
    uint8_t *buffer;
    uint8_t *chunk_seen;
    bool active;
} remote_input_task_buffer_t;
```

- [ ] **Step 2: Add stdlib include**

At the top of `remote_input_task.c`, include:

```c
#include <stdlib.h>
```

Keep existing `#include <string.h>`.

- [ ] **Step 3: Remove chunk seen length macro**

Remove `REMOTE_INPUT_CHUNK_SEEN_LEN`. Do not replace it with another capacity macro; the existing `frame->total_chunks == 0` and `expected_chunks_for_total()` checks are enough because the protocol maximum produces only 729 chunks.

- [ ] **Step 4: Add release helper**

Add this helper near the top of `remote_input_task.c`:

```c
static void release_task_memory(remote_input_task_buffer_t *task)
{
    if (task == NULL) {
        return;
    }

    free(task->buffer);
    free(task->chunk_seen);
    task->buffer = NULL;
    task->chunk_seen = NULL;
}
```

- [ ] **Step 5: Update init/reset**

Set `remote_input_task_init` to release nothing and clear a fresh object:

```c
void remote_input_task_init(remote_input_task_buffer_t *task)
{
    if (task == NULL) {
        return;
    }

    memset(task, 0, sizeof(*task));
}
```

Set `remote_input_task_reset` to:

```c
void remote_input_task_reset(remote_input_task_buffer_t *task)
{
    if (task == NULL) {
        return;
    }

    release_task_memory(task);
    memset(task, 0, sizeof(*task));
}
```

- [ ] **Step 6: Update task start allocation**

In `remote_input_task_start`, replace static buffer clearing with:

```c
    uint8_t *buffer = NULL;
    if (frame->total_bytes > 0) {
        buffer = (uint8_t *)calloc(1, frame->total_bytes);
        if (buffer == NULL) {
            return REMOTE_INPUT_ERR_TASK_TOO_LARGE;
        }
    }

    uint8_t *chunk_seen = (uint8_t *)calloc(frame->total_chunks, sizeof(uint8_t));
    if (chunk_seen == NULL) {
        free(buffer);
        return REMOTE_INPUT_ERR_TASK_TOO_LARGE;
    }

    task->task_id = frame->task_id;
    task->total_bytes = frame->total_bytes;
    task->total_chunks = frame->total_chunks;
    task->received_bytes = 0;
    task->received_chunks = 0;
    task->config = (remote_input_config_t) {0};
    task->buffer = buffer;
    task->chunk_seen = chunk_seen;
    task->active = true;
    return REMOTE_INPUT_ERR_OK;
```

Before this allocation block, keep all existing validation for active task, max bytes, nonzero chunks, and expected chunk count.

- [ ] **Step 7: Update add chunk null checks**

In `remote_input_task_add_chunk`, after duplicate and offset checks, ensure payload writes handle empty text:

```c
    if (frame->payload_len > 0) {
        if (frame->payload == NULL || task->buffer == NULL) {
            return REMOTE_INPUT_ERR_INVALID_CHUNK;
        }
        memcpy(&task->buffer[offset], frame->payload, frame->payload_len);
    }
```

Keep `task->chunk_seen[frame->chunk_index] = 1;`.

- [ ] **Step 8: Update commit output pointer**

In `remote_input_task_commit`, set:

```c
    *bytes = task->buffer;
    *len = task->total_bytes;
```

This means empty text returns `bytes == NULL` and `len == 0`, which existing writer validation accepts.

- [ ] **Step 9: Run firmware build**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS or fail only in writer runner fixed by Task 6. Do not proceed with hidden memory leaks.

- [ ] **Step 10: Commit dynamic receive buffer**

```bash
git add firmware/components/remote_input_core/include/remote_input_task.h firmware/components/remote_input_core/remote_input_task.c
git commit -m "feat: allocate receive task buffers dynamically"
```

---

### Task 6: Firmware Dynamic Writer Jobs

**Files:**
- Modify: `firmware/components/remote_input_device/remote_input_writer_runner.c`

**Interfaces:**
- Consumes: `remote_input_writer_runner_submit(uint16_t task_id, const uint8_t *bytes, size_t len, remote_input_config_t config)`.
- Produces: dynamically allocated writer jobs freed by worker.

- [ ] **Step 1: Add stdlib include**

Add:

```c
#include <stdlib.h>
```

- [ ] **Step 2: Change writer job struct**

Replace `writer_job_t` with:

```c
typedef struct {
    uint16_t task_id;
    size_t len;
    remote_input_config_t config;
    uint8_t *bytes;
} writer_job_t;
```

Remove:

```c
static writer_job_t s_pending_job;
```

- [ ] **Step 3: Add job free helper**

Add:

```c
static void free_job(writer_job_t *job)
{
    if (job == NULL) {
        return;
    }

    free(job->bytes);
    free(job);
}
```

- [ ] **Step 4: Free job after worker writes**

In `writer_worker_task`, after `notify_typing(false);` and before `set_active(false);`, free the job:

```c
        notify_typing(false);
        free_job(job);
        set_active(false);
```

- [ ] **Step 5: Allocate job in submit**

In `remote_input_writer_runner_submit`, after `reserve_writer()` succeeds, replace `s_pending_job` assignment with:

```c
    writer_job_t *job = (writer_job_t *)calloc(1, sizeof(writer_job_t));
    if (job == NULL) {
        set_active(false);
        return REMOTE_INPUT_ERR_TASK_TOO_LARGE;
    }

    job->task_id = task_id;
    job->len = len;
    job->config = config;

    if (len > 0) {
        job->bytes = (uint8_t *)malloc(len);
        if (job->bytes == NULL) {
            free_job(job);
            set_active(false);
            return REMOTE_INPUT_ERR_TASK_TOO_LARGE;
        }
        memcpy(job->bytes, bytes, len);
    }
```

Then enqueue this allocated pointer:

```c
    if (xQueueSend(s_queue, &job, 0) != pdTRUE) {
        free_job(job);
        set_active(false);
        return REMOTE_INPUT_ERR_DEVICE_BUSY;
    }
```

- [ ] **Step 6: Run firmware build**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS.

- [ ] **Step 7: Commit dynamic writer jobs**

```bash
git add firmware/components/remote_input_device/remote_input_writer_runner.c
git commit -m "feat: allocate writer jobs dynamically"
```

---

### Task 7: Firmware BLE and WebSocket Transport Limits

**Files:**
- Modify: `firmware/components/remote_input_device/remote_input_ble.c`
- Modify: `firmware/components/remote_input_device/remote_input_ws.c`

**Interfaces:**
- Consumes: `REMOTE_INPUT_DATA_FRAME_MAX_LEN`.
- Produces: BLE and WebSocket receivers accept 188-byte DATA frames and BLE Data supports write without response.

- [ ] **Step 1: Add BLE Data write without response flag**

In `remote_input_ble.c`, change the Data characteristic flags to:

```c
.flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
```

- [ ] **Step 2: Keep frame max macro constant-driven**

Confirm both `remote_input_ble.c` and `remote_input_ws.c` define:

```c
#define REMOTE_INPUT_DATA_FRAME_MAX_LEN (REMOTE_INPUT_DATA_FRAME_HEADER_LEN + REMOTE_INPUT_DATA_PAYLOAD_BYTES)
```

No hardcoded `20` should remain in receive buffer sizing.

- [ ] **Step 3: Run firmware build**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS.

- [ ] **Step 4: Commit transport frame limits**

```bash
git add firmware/components/remote_input_device/remote_input_ble.c firmware/components/remote_input_device/remote_input_ws.c
git commit -m "feat: expand firmware transport data frames"
```

---

### Task 8: Firmware BLE Connection Parameter and MTU Setup

**Files:**
- Modify: `firmware/components/remote_input_device/remote_input_ble.c`

**Interfaces:**
- Consumes: NimBLE `ble_att_set_preferred_mtu`, `ble_gap_update_params`, `ble_gap_conn_find`, `BLE_GAP_EVENT_CONN_UPDATE`, `BLE_GAP_EVENT_MTU`.
- Produces: preferred ATT MTU setup, low-latency connection parameter request, and diagnostics.

- [ ] **Step 1: Include ATT header**

Add this include to `remote_input_ble.c`:

```c
#include "host/ble_att.h"
```

- [ ] **Step 2: Set preferred MTU after NimBLE init**

In `remote_input_ble_init`, after `nimble_port_init()` succeeds and before GAP/GATT service setup, add:

```c
    int rc = ble_att_set_preferred_mtu(256);
    if (rc != 0) {
        ESP_LOGW(TAG, "failed to set preferred mtu rc=%d", rc);
    }
```

Then reuse the existing `rc` variable for later NimBLE calls. If this placement conflicts with local declaration order, keep the implementation C89-safe by declaring `int rc` before first assignment in the block.

- [ ] **Step 3: Add helper for connection parameter request**

Add this helper before `gap_event_cb`:

```c
static void request_fast_connection(uint16_t conn_handle)
{
    struct ble_gap_upd_params params = {
        .itvl_min = 6,
        .itvl_max = 12,
        .latency = 0,
        .supervision_timeout = 400,
        .min_ce_len = BLE_GAP_INITIAL_CONN_MIN_CE_LEN,
        .max_ce_len = BLE_GAP_INITIAL_CONN_MAX_CE_LEN,
    };

    int rc = ble_gap_update_params(conn_handle, &params);
    if (rc != 0) {
        ESP_LOGW(TAG, "failed to request fast connection params rc=%d", rc);
    }
}
```

`itvl_min = 6` is 7.5 ms and `itvl_max = 12` is 15 ms because BLE intervals use 1.25 ms units. `supervision_timeout = 400` is 4 seconds because it uses 10 ms units.

- [ ] **Step 4: Call helper after connect**

In the successful `BLE_GAP_EVENT_CONNECT` branch, after `s_conn_handle = event->connect.conn_handle;`, add:

```c
request_fast_connection(s_conn_handle);
```

- [ ] **Step 5: Log connection updates**

Add a `BLE_GAP_EVENT_CONN_UPDATE` case:

```c
    case BLE_GAP_EVENT_CONN_UPDATE: {
        ESP_LOGI(TAG, "connection updated status=%d", event->conn_update.status);
        struct ble_gap_conn_desc desc;
        int rc = ble_gap_conn_find(event->conn_update.conn_handle, &desc);
        if (rc == 0) {
            ESP_LOGI(TAG,
                     "conn params interval=%u latency=%u supervision_timeout=%u",
                     desc.conn_itvl,
                     desc.conn_latency,
                     desc.supervision_timeout);
        } else {
            ESP_LOGW(TAG, "failed to read conn desc rc=%d", rc);
        }
        return 0;
    }
```

- [ ] **Step 6: Log MTU updates**

Add a `BLE_GAP_EVENT_MTU` case:

```c
    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG,
                 "mtu updated conn_handle=%u channel_id=%u mtu=%u",
                 event->mtu.conn_handle,
                 event->mtu.channel_id,
                 event->mtu.value);
        return 0;
```

- [ ] **Step 7: Run firmware build**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS.

- [ ] **Step 8: Commit BLE connection diagnostics**

```bash
git add firmware/components/remote_input_device/remote_input_ble.c
git commit -m "feat: configure ble transfer parameters"
```

---

### Task 9: Protocol Documentation v2

**Files:**
- Modify: `docs/remote-input-protocol.md`

**Interfaces:**
- Consumes: final protocol constants and transport behavior from earlier tasks.
- Produces: user-facing v2 protocol documentation.

- [ ] **Step 1: Update overview and protocol version**

Change the opening description to state:

```markdown
本文档描述 Remote Input SDK 与 ESP32-S3 固件之间的通信协议。当前协议版本为 `2`。协议版本 `2` 不兼容版本 `1`。
```

- [ ] **Step 2: Update BLE characteristic properties**

In the BLE characteristic table, set Data property to:

```markdown
| Data | `9e7b0003-4f2a-4d3b-9c2a-0d6c9a120001` | Write, Write Without Response | SDK -> ESP32 |
```

- [ ] **Step 3: Update WebSocket frame description**

State:

```markdown
- START 和 COMMIT 使用 12 字节 Control 帧。
- DATA 使用 8 到 188 字节 Data 帧。
- 设备状态使用 14 字节 Status 帧从固件推送到浏览器。
```

Remove text that says WebSocket does not change protocol version or chunk size.

- [ ] **Step 4: Update limits table**

Set:

```markdown
| 协议版本 | `2` |
| 最大文本长度 | `128 * 1024` 字节 |
| 单个 Data 帧 payload 长度 | `180` 字节 |
```

- [ ] **Step 5: Update all frame version references**

Every frame table row for `version` should say:

```markdown
必须为 `2`
```

Status should say:

```markdown
固定为 `2`
```

- [ ] **Step 6: Update DATA section**

Set:

```markdown
Data 帧长度为 `8 + payload_len`。其中 `payload_len` 范围是 0 到 180 字节。
```

Change validation bullets to:

```markdown
- 帧总长度必须在 8 到 188 字节之间。
- 中间完整分片固定为 180 字节。
```

- [ ] **Step 7: Update normal flow chunk calculation**

Change:

```markdown
SDK 计算 `total_chunks = ceil(total_bytes / 180)`。
```

- [ ] **Step 8: Replace future v2 note**

Remove the section that says v2 may later introduce larger chunks. Replace with:

```markdown
协议版本 `2` 已固定使用 180 字节 Data payload，并且不兼容版本 `1`。后续如果需要进一步提升 WebSocket 单包大小或引入流式输入，应通过新的协议版本实现。
```

- [ ] **Step 9: Scan documentation for stale v1 values**

Run:

```bash
rg -n '版本为 `1`|必须为 `1`|固定为 `1`|16 \* 1024|16 KB|12 字节切片|payload 长度 \| `12`|8 到 20|ceil\(total_bytes / 12\)|版本 `1`' docs/remote-input-protocol.md
```

Expected: no output.

- [ ] **Step 10: Commit protocol docs**

```bash
git add docs/remote-input-protocol.md
git commit -m "docs: update protocol documentation for v2"
```

---

### Task 10: Final Verification

**Files:**
- No source edits expected unless verification reveals failures.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: passing SDK tests and firmware build in this environment.

- [ ] **Step 1: Run SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS with `sdk protocol tests passed`.

- [ ] **Step 2: Run firmware build**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS and build artifact such as `firmware/build/remote_input.bin`.

- [ ] **Step 3: Check worktree**

Run:

```bash
git status --short
```

Expected: no uncommitted source changes except ignored build outputs.

- [ ] **Step 4: Record hardware verification gaps**

Final handoff must explicitly state these were not run in this environment:

```text
BLE actual MTU and connection parameter acceptance on Chrome or Edge.
Web Bluetooth writeValueWithoutResponse behavior on the target browser and OS.
5000 Chinese character input latency.
USB HID long text stability.
LED and display states during long receive and long typing phases.
```
