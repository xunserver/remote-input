# WebSocket Network Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WiFi SoftAP and WebSocket input path so browsers can send Remote Input protocol frames directly to the ESP32-S3 while BLE remains available.

**Architecture:** Add a focused `remote_input_ws` receiver in `remote_input_device` that owns SoftAP, `esp_http_server`, WebSocket client tracking, binary frame parsing, and status push. Update `remote_input_service` to initialize multiple receivers, broadcast status, and treat the visible connected state as "at least one BLE or WebSocket client is connected." Add a browser SDK `WsTransport` that implements the existing `RemoteInputTransport` interface and reuses `RemoteInputClient`.

**Tech Stack:** ESP-IDF 6.0.2, C, FreeRTOS, `esp_wifi`, `esp_netif`, `esp_event`, `esp_http_server` WebSocket support, TypeScript ES modules, Vite, Node `assert` tests.

## Global Constraints

- Keep BLE enabled and available.
- Do not add an embedded HTTP UI page to the firmware.
- Do not introduce a JSON text protocol.
- Do not change Remote Input protocol version `1`, frame fields, byte order, chunk size, state codes, or error codes.
- WebSocket endpoint is `ws://192.168.4.1/ws`.
- Each WebSocket binary message contains exactly one existing v1 control or data frame.
- Firmware status messages sent over WebSocket are the existing 14-byte status frame.
- The WebSocket receiver sends the current status frame immediately after a client connects.
- First version uses WPA2-PSK AP security and no WebSocket token or TLS.
- Default AP SSID is `Remote-Input-S3`.
- Default AP password is `remoteinput`.
- Default AP channel is `6`.
- Default WebSocket max client count is `1`.
- Browser SDK default WebSocket URL is `ws://192.168.4.1/ws`.
- Agent environment must not run `idf.py flash`, `idf.py monitor`, or any command containing `flash` or `monitor`.

---

## File Structure

- Create `sdk/src/transport/ws.ts`: WebSocket transport and `connectWs(url?: string)`.
- Modify `sdk/src/types.ts`: add minimal WebSocket types for tests and non-DOM execution.
- Modify `sdk/src/index.ts`: export `connectWs` and include it in `RemoteInput`.
- Modify `sdk/tests/sdk-protocol.test.js`: add fake WebSocket tests for the SDK transport.
- Modify `sdk/index.html`: add WebSocket URL field and connect button while retaining BLE.
- Modify `docs/remote-input-protocol.md`: document WebSocket transport behavior and security note.
- Create `firmware/components/remote_input_device/include/remote_input_ws.h`: receiver declaration.
- Create `firmware/components/remote_input_device/remote_input_ws.c`: SoftAP, HTTP server, WebSocket receiver.
- Modify `firmware/components/remote_input_device/CMakeLists.txt`: add WS source and ESP-IDF requirements.
- Modify `firmware/components/remote_input_device/Kconfig`: add WebSocket/AP options.
- Modify `firmware/sdkconfig.defaults`: enable WebSocket receiver and HTTPD WebSocket support.
- Modify `firmware/components/remote_input_device/include/remote_input_display.h`: add transport-neutral connected setter.
- Modify `firmware/components/remote_input_device/remote_input_display.c`: display `Client: Connected` / `Client: Waiting`.
- Modify `firmware/components/remote_input_device/remote_input_service.c`: initialize receiver list, broadcast status, aggregate connection state.

---

### Task 1: SDK WebSocket Transport

**Files:**
- Create: `sdk/src/transport/ws.ts`
- Modify: `sdk/src/types.ts`
- Modify: `sdk/src/index.ts`
- Modify: `sdk/tests/sdk-protocol.test.js`

**Interfaces:**
- Consumes: `RemoteInputTransport` from `sdk/src/transport/types.ts`, `RemoteInputClient` from `sdk/src/device.ts`, `RemoteInputError` from `sdk/src/errors.ts`, and `decodeStatusFrame()` behavior through `RemoteInputClient`.
- Produces:
  - `export const DEFAULT_WS_URL = "ws://192.168.4.1/ws";`
  - `export class WsTransport implements RemoteInputTransport`
  - `export async function connectWs(url?: string): Promise<RemoteInputClient>`
  - `RemoteInput.connectWs` in `sdk/src/index.ts`

- [ ] **Step 1: Add failing SDK tests for WebSocket exports and default URL**

Append these helpers near the existing fake Bluetooth helpers in `sdk/tests/sdk-protocol.test.js`:

```js
class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.binaryType = "";
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(value) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket is not open");
    }
    this.sent.push(value instanceof Uint8Array ? Array.from(value) : value);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  openWithInitialStatus(status = createStatusFrame(0, 0)) {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
    this.emitMessage(status);
  }

  emitMessage(data) {
    this.emit("message", { data });
  }

  emitError(error = new Error("ws failed")) {
    this.emit("error", error);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
}

async function connectFakeWs(RemoteInput, url) {
  FakeWebSocket.instances = [];
  context.WebSocket = FakeWebSocket;
  const promise = url === undefined ? RemoteInput.connectWs() : RemoteInput.connectWs(url);
  await flushMicrotasks();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  socket.openWithInitialStatus();
  const device = await promise;
  return { device, socket };
}
```

Add these assertions after the existing export assertions:

```js
assert.equal(typeof remoteInputGlobal.connectWs, "function");
assert.equal(remoteInputGlobal.RemoteInput.connectWs, remoteInputGlobal.connectWs);
```

Add these cases inside `runSdkFlowTests()`:

```js
  {
    delete context.WebSocket;
    await assertRejectsWithCode(RemoteInput.connectWs(), "WEB_SOCKET_UNSUPPORTED");
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    assert.equal(socket.url, "ws://192.168.4.1/ws");
    assert.equal(socket.binaryType, "arraybuffer");
    assert.equal(device.connected, true);
    const status = await device.getStatus();
    assert.equal(status.state, "idle");
  }

  {
    const { socket } = await connectFakeWs(RemoteInput, "ws://192.168.4.1/ws");
    assert.equal(socket.url, "ws://192.168.4.1/ws");
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    const completion = device.typeText("ws");
    await flushMicrotasks();
    assert.deepEqual(socket.sent[0], [1, 1, 1, 0, 2, 0, 0, 0, 1, 0, 0, 0]);
    assert.deepEqual(socket.sent[1], [1, 16, 1, 0, 0, 0, 1, 0, 119, 115]);
    assert.deepEqual(socket.sent[2], [1, 2, 1, 0, 2, 0, 0, 0, 1, 0, 0, 0]);
    socket.emitMessage(createStatusFrame(3, 1, 0, 2, 2));
    const status = await completion;
    assert.equal(status.state, "done");
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    const completion = device.typeText("close");
    await flushMicrotasks();
    socket.close();
    await assertRejectsWithCodeBeforeTimeout(completion, "DISCONNECTED");
    assert.equal(device.connected, false);
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    const completion = device.typeText("bad");
    await flushMicrotasks();
    socket.emitMessage(new ArrayBuffer(2));
    await assertRejectsWithCode(completion, "INVALID_STATUS_FRAME");
    assert.equal(device.pending, null);
  }

  {
    FakeWebSocket.instances = [];
    context.WebSocket = FakeWebSocket;
    const promise = RemoteInput.connectWs();
    await flushMicrotasks();
    FakeWebSocket.instances[0].emitError(new Error("cannot connect"));
    await assertRejectsWithCode(promise, "WEB_SOCKET_CONNECT_FAILED");
  }
```

- [ ] **Step 2: Run SDK test to verify it fails**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: FAIL with an assertion that `connectWs` is not a function or a module build error for missing exports.

- [ ] **Step 3: Add WebSocket types**

In `sdk/src/types.ts`, append:

```ts
export interface RemoteWebSocketEventMap {
  open: Event;
  close: CloseEvent;
  error: Event;
  message: MessageEvent;
}

export interface RemoteWebSocket {
  readonly readyState: number;
  binaryType: BinaryType;
  addEventListener<K extends keyof RemoteWebSocketEventMap>(
    type: K,
    listener: (event: RemoteWebSocketEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof RemoteWebSocketEventMap>(
    type: K,
    listener: (event: RemoteWebSocketEventMap[K]) => void,
  ): void;
  send(data: Uint8Array): void;
  close(): void;
}

export interface RemoteWebSocketConstructor {
  readonly OPEN: number;
  new (url: string): RemoteWebSocket;
}
```

- [ ] **Step 4: Implement `sdk/src/transport/ws.ts`**

Create `sdk/src/transport/ws.ts`:

```ts
import { RemoteInputClient } from "../device";
import { getErrorMessage, RemoteInputError } from "../errors";
import type { RemoteWebSocket, RemoteWebSocketConstructor } from "../types";
import type {
  RemoteInputDisconnectListener,
  RemoteInputStatusListener,
  RemoteInputTransport,
} from "./types";

export const DEFAULT_WS_URL = "ws://192.168.4.1/ws";

function toDataView(data: unknown): DataView {
  if (data instanceof DataView) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new DataView(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new RemoteInputError("INVALID_STATUS_FRAME", "Invalid status frame");
}

function cloneDataView(view: DataView): DataView {
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return new DataView(bytes.buffer);
}

export class WsTransport implements RemoteInputTransport {
  readonly kind = "ws";
  readonly socket: RemoteWebSocket;
  private readonly WebSocketCtor: RemoteWebSocketConstructor;
  private statusListeners = new Set<RemoteInputStatusListener>();
  private disconnectListeners = new Set<RemoteInputDisconnectListener>();
  private latestStatus: DataView | null = null;
  private isConnected = true;

  constructor(socket: RemoteWebSocket, WebSocketCtor: RemoteWebSocketConstructor, initialStatus: DataView) {
    this.socket = socket;
    this.WebSocketCtor = WebSocketCtor;
    this.latestStatus = cloneDataView(initialStatus);
    this.handleMessage = this.handleMessage.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.socket.addEventListener("message", this.handleMessage);
    this.socket.addEventListener("close", this.handleClose);
  }

  get connected(): boolean {
    return this.isConnected && this.socket.readyState === this.WebSocketCtor.OPEN;
  }

  writeControl(frame: Uint8Array): Promise<void> {
    return this.writeFrame(frame);
  }

  writeData(frame: Uint8Array): Promise<void> {
    return this.writeFrame(frame);
  }

  async readStatus(): Promise<DataView> {
    if (!this.connected) {
      throw new RemoteInputError("NOT_CONNECTED", "Device is not connected");
    }
    if (!this.latestStatus) {
      throw new RemoteInputError("WS_STATUS_UNAVAILABLE", "WebSocket status is not available");
    }
    return cloneDataView(this.latestStatus);
  }

  onStatus(listener: RemoteInputStatusListener): void {
    this.statusListeners.add(listener);
  }

  offStatus(listener: RemoteInputStatusListener): void {
    this.statusListeners.delete(listener);
  }

  onDisconnect(listener: RemoteInputDisconnectListener): void {
    this.disconnectListeners.add(listener);
  }

  offDisconnect(listener: RemoteInputDisconnectListener): void {
    this.disconnectListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("close", this.handleClose);
    if (this.socket.readyState === this.WebSocketCtor.OPEN) {
      this.socket.close();
    }
  }

  private writeFrame(frame: Uint8Array): Promise<void> {
    if (!this.connected) {
      return Promise.reject(new RemoteInputError("NOT_CONNECTED", "Device is not connected"));
    }
    try {
      this.socket.send(frame);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(new RemoteInputError("WS_WRITE_FAILED", getErrorMessage(error, "WebSocket write failed"), error));
    }
  }

  private handleMessage(event: MessageEvent): void {
    let status: DataView;
    try {
      status = cloneDataView(toDataView(event.data));
    } catch {
      status = new DataView(new ArrayBuffer(0));
    }
    this.latestStatus = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private handleClose(): void {
    this.isConnected = false;
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}

export async function connectWs(url = DEFAULT_WS_URL): Promise<RemoteInputClient> {
  const WebSocketCtor = globalThis.WebSocket as RemoteWebSocketConstructor | undefined;
  if (!WebSocketCtor) {
    throw new RemoteInputError("WEB_SOCKET_UNSUPPORTED", "WebSocket is not available");
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(url);
    socket.binaryType = "arraybuffer";
    let settled = false;

    const cleanupBeforeTransport = (): void => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", handleInitialMessage);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
    };

    const fail = (code: string, message: string, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanupBeforeTransport();
      try {
        socket.close();
      } catch {
        // Ignore cleanup errors while reporting the original connection failure.
      }
      reject(new RemoteInputError(code, message, cause));
    };

    const handleOpen = (): void => {
      socket.addEventListener("message", handleInitialMessage);
    };

    const handleInitialMessage = (event: MessageEvent): void => {
      let initialStatus: DataView;
      try {
        initialStatus = toDataView(event.data);
      } catch (error) {
        fail("INVALID_STATUS_FRAME", getErrorMessage(error, "Invalid status frame"), error);
        return;
      }
      settled = true;
      cleanupBeforeTransport();
      resolve(new RemoteInputClient(new WsTransport(socket, WebSocketCtor, initialStatus)));
    };

    const handleError = (event: Event): void => {
      fail("WEB_SOCKET_CONNECT_FAILED", "WebSocket connection failed", event);
    };

    const handleClose = (): void => {
      fail("WEB_SOCKET_CONNECT_FAILED", "WebSocket closed before initial status");
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });
}
```

- [ ] **Step 5: Export `connectWs`**

Modify `sdk/src/index.ts` imports/exports:

```ts
export { connect, connectBle } from "./bluetooth";
export { connectWs } from "./transport/ws";
export { RemoteInputClient, RemoteInputDevice } from "./device";
export { RemoteInputError } from "./errors";
export type { RemoteInputStatus } from "./types";
export type {
  RemoteInputDisconnectListener,
  RemoteInputStatusListener,
  RemoteInputTransport,
} from "./transport/types";

import { connect, connectBle } from "./bluetooth";
import { RemoteInputClient, RemoteInputDevice } from "./device";
import { RemoteInputError } from "./errors";
import { assertTextSize, constants, createDataFrames, decodeStatusFrame, encodeControlFrame } from "./protocol";
import { connectWs } from "./transport/ws";
```

Update the `RemoteInput` object:

```ts
export const RemoteInput = {
  connect,
  connectBle,
  connectWs,
  RemoteInputError,
  RemoteInputClient,
  RemoteInputDevice,
  _internals,
};
```

- [ ] **Step 6: Run SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS and prints `sdk protocol tests passed`.

- [ ] **Step 7: Commit SDK transport**

```bash
git add sdk/src/transport/ws.ts sdk/src/types.ts sdk/src/index.ts sdk/tests/sdk-protocol.test.js
git commit -m "feat: add websocket sdk transport"
```

---

### Task 2: Firmware WebSocket Receiver

**Files:**
- Create: `firmware/components/remote_input_device/include/remote_input_ws.h`
- Create: `firmware/components/remote_input_device/remote_input_ws.c`
- Modify: `firmware/components/remote_input_device/CMakeLists.txt`
- Modify: `firmware/components/remote_input_device/Kconfig`
- Modify: `firmware/sdkconfig.defaults`

**Interfaces:**
- Consumes: `remote_input_receiver_t`, `remote_input_parse_control_frame()`, `remote_input_parse_data_frame()`, `remote_input_status_encode()`.
- Produces:
  - `extern const remote_input_receiver_t remote_input_ws_receiver;`
  - `esp_err_t remote_input_ws_init(const remote_input_receiver_callbacks_t *callbacks);`
  - `void remote_input_ws_notify_status(void);`

- [ ] **Step 1: Add Kconfig and build settings**

Append to `firmware/components/remote_input_device/Kconfig` inside `menu "Remote Input Device"`:

```text
config REMOTE_INPUT_WS_ENABLED
    bool "Enable WebSocket input receiver"
    default y
    help
        Start a WiFi SoftAP and WebSocket endpoint for browser-based
        Remote Input protocol frames.

config REMOTE_INPUT_WIFI_AP_SSID
    string "WebSocket SoftAP SSID"
    default "Remote-Input-S3"
    depends on REMOTE_INPUT_WS_ENABLED

config REMOTE_INPUT_WIFI_AP_PASSWORD
    string "WebSocket SoftAP WPA2 password"
    default "remoteinput"
    depends on REMOTE_INPUT_WS_ENABLED
    help
        WPA2 password for the SoftAP. Must be at least 8 characters.

config REMOTE_INPUT_WIFI_AP_CHANNEL
    int "WebSocket SoftAP channel"
    range 1 13
    default 6
    depends on REMOTE_INPUT_WS_ENABLED

config REMOTE_INPUT_WS_MAX_CLIENTS
    int "Maximum WebSocket clients"
    range 1 4
    default 1
    depends on REMOTE_INPUT_WS_ENABLED
```

Add to `firmware/sdkconfig.defaults`:

```text
CONFIG_REMOTE_INPUT_WS_ENABLED=y
CONFIG_REMOTE_INPUT_WIFI_AP_SSID="Remote-Input-S3"
CONFIG_REMOTE_INPUT_WIFI_AP_PASSWORD="remoteinput"
CONFIG_REMOTE_INPUT_WIFI_AP_CHANNEL=6
CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS=1
CONFIG_HTTPD_WS_SUPPORT=y
```

Modify `firmware/components/remote_input_device/CMakeLists.txt`:

```cmake
    SRCS
        "remote_input_ble.c"
        "remote_input_display.c"
        "remote_input_hid.c"
        "remote_input_lcd_port.c"
        "remote_input_led.c"
        "remote_input_service.c"
        "remote_input_writer_runner.c"
        "remote_input_ws.c"
        "${remote_input_firmware_version_source}"
```

Add these requirements:

```cmake
        esp_event
        esp_http_server
        esp_netif
        esp_wifi
```

- [ ] **Step 2: Add receiver header**

Create `firmware/components/remote_input_device/include/remote_input_ws.h`:

```c
#pragma once

#include "remote_input_receiver.h"

#include "esp_err.h"

extern const remote_input_receiver_t remote_input_ws_receiver;

esp_err_t remote_input_ws_init(const remote_input_receiver_callbacks_t *callbacks);
void remote_input_ws_notify_status(void);
```

- [ ] **Step 3: Add WebSocket receiver implementation**

Create `firmware/components/remote_input_device/remote_input_ws.c`:

```c
#include "remote_input_ws.h"

#include "remote_input_protocol.h"
#include "remote_input_status.h"

#include "esp_check.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "sdkconfig.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define REMOTE_INPUT_WS_URI "/ws"
#define REMOTE_INPUT_DATA_FRAME_MAX_LEN (REMOTE_INPUT_DATA_FRAME_HEADER_LEN + REMOTE_INPUT_DATA_PAYLOAD_BYTES)

static const char *TAG = "remote_input_ws";

static remote_input_receiver_callbacks_t s_callbacks;
static httpd_handle_t s_server;
static int s_client_fds[CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS];
static portMUX_TYPE s_client_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_netif_initialized;
static bool s_event_loop_initialized;

static void reset_clients(void)
{
    portENTER_CRITICAL(&s_client_lock);
    for (size_t i = 0; i < CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS; i += 1) {
        s_client_fds[i] = -1;
    }
    portEXIT_CRITICAL(&s_client_lock);
}

static bool add_client(int fd)
{
    bool added = false;

    portENTER_CRITICAL(&s_client_lock);
    for (size_t i = 0; i < CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS; i += 1) {
        if (s_client_fds[i] == fd) {
            added = true;
            break;
        }
        if (s_client_fds[i] < 0) {
            s_client_fds[i] = fd;
            added = true;
            break;
        }
    }
    portEXIT_CRITICAL(&s_client_lock);

    return added;
}

static bool remove_client(int fd)
{
    bool removed = false;

    portENTER_CRITICAL(&s_client_lock);
    for (size_t i = 0; i < CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS; i += 1) {
        if (s_client_fds[i] == fd) {
            s_client_fds[i] = -1;
            removed = true;
            break;
        }
    }
    portEXIT_CRITICAL(&s_client_lock);

    return removed;
}

static void copy_client_fds(int *fds, size_t count)
{
    portENTER_CRITICAL(&s_client_lock);
    for (size_t i = 0; i < count; i += 1) {
        fds[i] = s_client_fds[i];
    }
    portEXIT_CRITICAL(&s_client_lock);
}

static void notify_error(remote_input_error_t error)
{
    if (s_callbacks.on_error != NULL) {
        s_callbacks.on_error(error, s_callbacks.ctx);
    }
}

static esp_err_t send_status_to_fd(int fd)
{
    if (s_server == NULL || httpd_ws_get_fd_info(s_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
        remove_client(fd);
        return ESP_FAIL;
    }

    uint8_t status[REMOTE_INPUT_STATUS_FRAME_LEN];
    remote_input_status_encode(status);

    httpd_ws_frame_t frame = {
        .final = true,
        .fragmented = false,
        .type = HTTPD_WS_TYPE_BINARY,
        .payload = status,
        .len = sizeof(status),
    };
    esp_err_t err = httpd_ws_send_frame_async(s_server, fd, &frame);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to send status fd=%d: %s", fd, esp_err_to_name(err));
        remove_client(fd);
    }
    return err;
}

static void handle_binary_frame(const uint8_t *payload, size_t len)
{
    if (payload == NULL) {
        notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
        return;
    }

    const uint8_t type = len > 1 ? payload[1] : 0;

    if (len == REMOTE_INPUT_CONTROL_FRAME_LEN &&
        (type == REMOTE_INPUT_CONTROL_START || type == REMOTE_INPUT_CONTROL_COMMIT)) {
        remote_input_control_frame_t frame;
        if (!remote_input_parse_control_frame(payload, len, &frame)) {
            notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
            return;
        }
        if (s_callbacks.on_control != NULL) {
            s_callbacks.on_control(&frame, s_callbacks.ctx);
        }
        return;
    }

    if (len >= REMOTE_INPUT_DATA_FRAME_HEADER_LEN && len <= REMOTE_INPUT_DATA_FRAME_MAX_LEN &&
        type == REMOTE_INPUT_DATA_FRAME) {
        remote_input_data_frame_t frame;
        if (!remote_input_parse_data_frame(payload, len, &frame)) {
            notify_error(REMOTE_INPUT_ERR_INVALID_CHUNK);
            return;
        }
        if (s_callbacks.on_data != NULL) {
            s_callbacks.on_data(&frame, s_callbacks.ctx);
        }
        return;
    }

    notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
}

static esp_err_t ws_handler(httpd_req_t *req)
{
    const int fd = httpd_req_to_sockfd(req);

    if (req->method == HTTP_GET) {
        if (!add_client(fd)) {
            ESP_LOGW(TAG, "rejecting extra websocket client fd=%d", fd);
            return ESP_FAIL;
        }
        ESP_LOGI(TAG, "websocket connected fd=%d", fd);
        if (s_callbacks.on_connect != NULL) {
            s_callbacks.on_connect(s_callbacks.ctx);
        }
        return send_status_to_fd(fd);
    }

    httpd_ws_frame_t frame = { 0 };
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        if (remove_client(fd) && s_callbacks.on_disconnect != NULL) {
            s_callbacks.on_disconnect(s_callbacks.ctx);
        }
        return err;
    }

    if (frame.type == HTTPD_WS_TYPE_CLOSE) {
        if (remove_client(fd) && s_callbacks.on_disconnect != NULL) {
            s_callbacks.on_disconnect(s_callbacks.ctx);
        }
        return ESP_OK;
    }

    if (frame.type != HTTPD_WS_TYPE_BINARY || frame.len > REMOTE_INPUT_DATA_FRAME_MAX_LEN) {
        notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
        return ESP_OK;
    }

    uint8_t payload[REMOTE_INPUT_DATA_FRAME_MAX_LEN];
    frame.payload = payload;
    err = httpd_ws_recv_frame(req, &frame, sizeof(payload));
    if (err != ESP_OK) {
        notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
        return err;
    }

    if (frame.type != HTTPD_WS_TYPE_BINARY) {
        notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
        return ESP_OK;
    }

    handle_binary_frame(payload, frame.len);
    return ESP_OK;
}

static esp_err_t init_wifi_ap(void)
{
    if (strlen(CONFIG_REMOTE_INPUT_WIFI_AP_PASSWORD) < 8) {
        ESP_LOGE(TAG, "wifi ap password must be at least 8 characters");
        return ESP_ERR_INVALID_ARG;
    }

    if (!s_netif_initialized) {
        ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "esp_netif_init failed");
        s_netif_initialized = true;
    }

    if (!s_event_loop_initialized) {
        esp_err_t event_err = esp_event_loop_create_default();
        if (event_err != ESP_OK && event_err != ESP_ERR_INVALID_STATE) {
            ESP_LOGE(TAG, "event loop init failed: %s", esp_err_to_name(event_err));
            return event_err;
        }
        s_event_loop_initialized = true;
    }

    esp_netif_create_default_wifi_ap();

    wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init_config), TAG, "esp_wifi_init failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "esp_wifi_set_storage failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_AP), TAG, "esp_wifi_set_mode failed");

    wifi_config_t wifi_config = { 0 };
    strlcpy((char *)wifi_config.ap.ssid, CONFIG_REMOTE_INPUT_WIFI_AP_SSID, sizeof(wifi_config.ap.ssid));
    strlcpy((char *)wifi_config.ap.password, CONFIG_REMOTE_INPUT_WIFI_AP_PASSWORD, sizeof(wifi_config.ap.password));
    wifi_config.ap.ssid_len = strlen(CONFIG_REMOTE_INPUT_WIFI_AP_SSID);
    wifi_config.ap.channel = CONFIG_REMOTE_INPUT_WIFI_AP_CHANNEL;
    wifi_config.ap.authmode = WIFI_AUTH_WPA2_PSK;
    wifi_config.ap.max_connection = CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS;

    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_AP, &wifi_config), TAG, "esp_wifi_set_config failed");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "esp_wifi_start failed");
    ESP_LOGI(TAG, "wifi ap started ssid=%s channel=%d", CONFIG_REMOTE_INPUT_WIFI_AP_SSID, CONFIG_REMOTE_INPUT_WIFI_AP_CHANNEL);
    return ESP_OK;
}

static esp_err_t init_http_server(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_open_sockets = CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS + 2;

    ESP_RETURN_ON_ERROR(httpd_start(&s_server, &config), TAG, "httpd_start failed");

    httpd_uri_t ws_uri = {
        .uri = REMOTE_INPUT_WS_URI,
        .method = HTTP_GET,
        .handler = ws_handler,
        .user_ctx = NULL,
        .is_websocket = true,
        .handle_ws_control_frames = true,
    };
    ESP_RETURN_ON_ERROR(httpd_register_uri_handler(s_server, &ws_uri), TAG, "register ws uri failed");
    ESP_LOGI(TAG, "websocket endpoint ready at ws://192.168.4.1%s", REMOTE_INPUT_WS_URI);
    return ESP_OK;
}

void remote_input_ws_notify_status(void)
{
    int fds[CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS];
    copy_client_fds(fds, CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS);

    for (size_t i = 0; i < CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS; i += 1) {
        if (fds[i] >= 0) {
            (void)send_status_to_fd(fds[i]);
        }
    }
}

esp_err_t remote_input_ws_init(const remote_input_receiver_callbacks_t *callbacks)
{
    if (callbacks != NULL) {
        s_callbacks = *callbacks;
    } else {
        memset(&s_callbacks, 0, sizeof(s_callbacks));
    }

    reset_clients();

    esp_err_t err = init_wifi_ap();
    if (err != ESP_OK) {
        return err;
    }

    err = init_http_server();
    if (err != ESP_OK) {
        return err;
    }

    return ESP_OK;
}

const remote_input_receiver_t remote_input_ws_receiver = {
    .name = "ws",
    .init = remote_input_ws_init,
    .notify_status = remote_input_ws_notify_status,
};
```

- [ ] **Step 4: Run firmware build**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS. This confirms the new receiver source, Kconfig defaults, CMake requirements, WiFi APIs, and HTTP WebSocket APIs compile before service integration.

- [ ] **Step 5: Commit receiver module**

Commit the receiver module:

```bash
git add firmware/components/remote_input_device/include/remote_input_ws.h firmware/components/remote_input_device/remote_input_ws.c firmware/components/remote_input_device/CMakeLists.txt firmware/components/remote_input_device/Kconfig firmware/sdkconfig.defaults
git commit -m "feat: add websocket firmware receiver"
```

---

### Task 3: Multi-Receiver Service and Connected State

**Files:**
- Modify: `firmware/components/remote_input_device/remote_input_service.c`
- Modify: `firmware/components/remote_input_device/include/remote_input_display.h`
- Modify: `firmware/components/remote_input_device/remote_input_display.c`

**Interfaces:**
- Consumes:
  - `remote_input_ble_receiver`
  - `remote_input_ws_receiver`
  - `remote_input_display_set_ble_connected(bool connected)`
- Produces:
  - `remote_input_display_set_client_connected(bool connected)`
  - service-level receiver broadcast over every initialized receiver
  - visible connected state aggregated across BLE and WebSocket connection counts

- [ ] **Step 1: Add display client connected API**

Modify `firmware/components/remote_input_device/include/remote_input_display.h`:

```c
esp_err_t remote_input_display_init(const char *version);
void remote_input_display_set_client_connected(bool connected);
void remote_input_display_set_ble_connected(bool connected);
void remote_input_display_set_input_state(remote_input_state_t state);
```

Modify `firmware/components/remote_input_device/remote_input_display.c`:

```c
static lv_obj_t *s_client_label;
static bool s_client_connected;
```

Replace `s_ble_label` uses with `s_client_label`, and replace `s_ble_connected` with `s_client_connected`. The label text in `flush_status_labels()` must be:

```c
lv_label_set_text(s_client_label, client_connected ? "Client: Connected" : "Client: Waiting");
```

Initialize with:

```c
s_client_label = create_label(s_root, "Client: Waiting");
```

Add the new setter and keep the BLE wrapper:

```c
void remote_input_display_set_client_connected(bool connected)
{
    bool initialized;

    portENTER_CRITICAL(&s_state_lock);
    initialized = s_initialized;
    if (initialized) {
        s_client_connected = connected;
    }
    portEXIT_CRITICAL(&s_state_lock);

    if (initialized) {
        request_async_flush();
    }
}

void remote_input_display_set_ble_connected(bool connected)
{
    remote_input_display_set_client_connected(connected);
}
```

- [ ] **Step 2: Update service includes and receiver list**

Modify `firmware/components/remote_input_device/remote_input_service.c` includes:

```c
#include "remote_input_ble.h"
#include "remote_input_display.h"
#include "remote_input_engine.h"
#include "remote_input_firmware_version.h"
#include "remote_input_hid.h"
#include "remote_input_lcd_port.h"
#include "remote_input_led.h"
#include "remote_input_receiver.h"
#include "remote_input_status.h"
#include "remote_input_writer_runner.h"
#include "remote_input_ws.h"
```

Replace:

```c
static const remote_input_receiver_t *s_receiver = &remote_input_ble_receiver;
```

with:

```c
#define REMOTE_INPUT_MAX_RECEIVERS 2

typedef struct {
    const remote_input_receiver_t *receiver;
    bool initialized;
} receiver_slot_t;

static receiver_slot_t s_receivers[REMOTE_INPUT_MAX_RECEIVERS] = {
    { .receiver = &remote_input_ble_receiver, .initialized = false },
#if CONFIG_REMOTE_INPUT_WS_ENABLED
    { .receiver = &remote_input_ws_receiver, .initialized = false },
#else
    { .receiver = NULL, .initialized = false },
#endif
};

static int s_connected_clients;
```

- [ ] **Step 3: Broadcast status to initialized receivers**

Replace the notify block in `update_status()`:

```c
    for (size_t i = 0; i < REMOTE_INPUT_MAX_RECEIVERS; i += 1) {
        if (s_receivers[i].initialized &&
            s_receivers[i].receiver != NULL &&
            s_receivers[i].receiver->notify_status != NULL) {
            s_receivers[i].receiver->notify_status();
        }
    }
```

- [ ] **Step 4: Aggregate connection callbacks**

Replace `on_connect()` and `on_disconnect()`:

```c
static void set_client_connected(bool connected)
{
    remote_input_led_set_connected(connected);
    remote_input_display_set_client_connected(connected);
}

static void on_connect(void *ctx)
{
    (void)ctx;

    if (s_connected_clients < INT_MAX) {
        s_connected_clients += 1;
    }
    set_client_connected(s_connected_clients > 0);
}

static void on_disconnect(void *ctx)
{
    (void)ctx;

    if (s_connected_clients > 0) {
        s_connected_clients -= 1;
    }
    set_client_connected(s_connected_clients > 0);

    if (s_connected_clients == 0 && !remote_input_writer_runner_busy()) {
        update_status(REMOTE_INPUT_STATE_IDLE, 0, REMOTE_INPUT_ERR_OK, 0, 0);
        remote_input_engine_reset_receive(&s_engine);
    }
}
```

Add `#include <limits.h>` near the other includes.

- [ ] **Step 5: Initialize every receiver and require at least one success**

Replace the single receiver init block at the end of `remote_input_service_init()` with:

```c
    const remote_input_receiver_callbacks_t callbacks = {
        .on_connect = on_connect,
        .on_control = on_control,
        .on_data = on_data,
        .on_error = on_receiver_error,
        .on_disconnect = on_disconnect,
        .ctx = NULL,
    };

    size_t initialized_receivers = 0;
    for (size_t i = 0; i < REMOTE_INPUT_MAX_RECEIVERS; i += 1) {
        if (s_receivers[i].receiver == NULL || s_receivers[i].receiver->init == NULL) {
            continue;
        }
        err = s_receivers[i].receiver->init(&callbacks);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "%s receiver init failed: %s",
                     s_receivers[i].receiver->name,
                     esp_err_to_name(err));
            continue;
        }
        s_receivers[i].initialized = true;
        initialized_receivers += 1;
    }

    if (initialized_receivers == 0) {
        ESP_LOGE(TAG, "no input receiver initialized");
        return ESP_FAIL;
    }
```

- [ ] **Step 6: Run firmware build**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS and generates `firmware/build/remote_input.bin`.

- [ ] **Step 7: Commit service integration**

```bash
git add firmware/components/remote_input_device/remote_input_service.c firmware/components/remote_input_device/include/remote_input_display.h firmware/components/remote_input_device/remote_input_display.c
git commit -m "feat: support multiple input receivers"
```

---

### Task 4: Demo, Protocol Docs, and Full Verification

**Files:**
- Modify: `sdk/index.html`
- Modify: `docs/remote-input-protocol.md`

**Interfaces:**
- Consumes: `RemoteInput.connect()` for BLE and `RemoteInput.connectWs(url?: string)` for WebSocket.
- Produces: Demo UI that can choose BLE or WebSocket and documentation describing the WebSocket transport.

- [ ] **Step 1: Update demo UI controls**

Modify the toolbar in `sdk/index.html`:

```html
<div class="toolbar">
  <button id="connectButton" type="button">BLE 连接</button>
  <input id="wsUrlInput" type="url" value="ws://192.168.4.1/ws" aria-label="WebSocket URL">
  <button id="connectWsButton" type="button">WS 连接</button>
  <button id="disconnectButton" type="button" disabled>断开</button>
  <button id="statusButton" type="button" disabled>状态</button>
</div>
```

Update script element references:

```js
const connectWsButton = document.querySelector("#connectWsButton");
const wsUrlInput = document.querySelector("#wsUrlInput");
```

Update `setConnected(value)`:

```js
function setConnected(value) {
  connectButton.disabled = value;
  connectWsButton.disabled = value;
  wsUrlInput.disabled = value;
  disconnectButton.disabled = !value;
  statusButton.disabled = !value;
  typeButton.disabled = !value;
}
```

Add a WebSocket connect handler:

```js
connectWsButton.addEventListener("click", async () => {
  try {
    device = await RemoteInput.connectWs(wsUrlInput.value.trim() || undefined);
    setConnected(true);
    statusOutput.textContent = "WebSocket 已连接";
  } catch (error) {
    statusOutput.textContent = formatError(error);
  }
});
```

Keep the existing BLE connect handler but change success text to:

```js
statusOutput.textContent = "BLE 已连接";
```

- [ ] **Step 2: Add docs for WebSocket transport**

In `docs/remote-input-protocol.md`, add a new section after BLE transport:

```markdown
## 2. WebSocket 传输层

固件可同时启用 BLE 和 WebSocket。WebSocket 第一版运行在 ESP32 SoftAP 上：

| 项目 | 值 |
| --- | --- |
| AP SSID | `Remote-Input-S3` |
| AP 密码 | `remoteinput` |
| URL | `ws://192.168.4.1/ws` |
| 消息类型 | binary |

每条 WebSocket binary message 直接承载一个现有协议帧：

- START 和 COMMIT 使用 12 字节 Control 帧。
- DATA 使用 8 到 20 字节 Data 帧。
- 设备状态使用 14 字节 Status 帧从固件推送到浏览器。

WebSocket 不增加外层 envelope，不使用 JSON，不改变协议版本、字节序、chunk 大小、状态码或错误码。客户端连接成功后，固件会立即推送当前 Status 帧，之后每次状态变化都会继续推送。

安全边界：第一版依赖 SoftAP 的 WPA2 密码限制访问，不提供 WebSocket token 或 TLS。任何知道 AP 密码并连接到该热点的客户端都可以向 USB host 注入输入内容。
```

Renumber later section headings if needed so numbering remains monotonic.

- [ ] **Step 3: Run SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS and prints `sdk protocol tests passed`.

- [ ] **Step 4: Run firmware build**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS and generates `firmware/build/remote_input.bin`.

- [ ] **Step 5: Review final diff**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected:

- `git diff --check` prints no output.
- Changed files are limited to SDK WebSocket transport/tests/demo, firmware WebSocket receiver/service/config/display, and protocol docs.

- [ ] **Step 6: Commit docs and demo**

```bash
git add sdk/index.html docs/remote-input-protocol.md
git commit -m "docs: describe websocket transport"
```

If Task 4 fixes small issues in earlier task files, include those exact files in the same commit and use:

```bash
git commit -m "fix: complete websocket transport integration"
```

---

## Manual Hardware Verification

Do not run these in the agent environment. A hardware-capable environment should verify:

- ESP32 starts WPA2 AP `Remote-Input-S3`.
- Browser host joins the AP using password `remoteinput`.
- SDK demo connects to `ws://192.168.4.1/ws`.
- WebSocket text send produces USB HID input on the target host.
- BLE text send still works.
- BLE and WebSocket can be connected at the same time.
- During an active task, a second task from the other transport receives busy/error behavior without corrupting the active task.
- Disconnecting WebSocket updates LED/LCD connected state according to "at least one client connected."

## Self-Review

- Spec coverage: SoftAP, WebSocket endpoint, binary frame reuse, initial status push, SDK `connectWs()`, multi-receiver service, status broadcast, config defaults, security docs, SDK tests, firmware build, and hardware verification all map to tasks.
- Placeholder scan: no unresolved markers or undefined task references remain.
- Type consistency: `connectWs(url?: string): Promise<RemoteInputClient>`, `WsTransport`, `remote_input_ws_receiver`, `remote_input_ws_init()`, `remote_input_ws_notify_status()`, and `remote_input_display_set_client_connected(bool)` are consistently named across tasks.
