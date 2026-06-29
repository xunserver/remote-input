# ESP32-S3 Web Bluetooth HID Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 ESP32-S3 + Web Bluetooth + USB HID 原型，让桌面 Chrome/Edge 通过 BLE 发送文本，ESP32-S3 在目标 Windows 上用 HexNumpad HID 序列输入 Unicode 文本。

**Architecture:** 浏览器端是纯单文件 JavaScript SDK 和最小 demo 页面；固件端是标准 ESP-IDF 6.x 工程，启用 NimBLE GATT Server 和 TinyUSB HID Keyboard。两端共享同一套二进制 BLE 协议：SDK 负责 UTF-8 编码、分片、发送和等待完成；固件负责收包、校验、UTF-8 解码、HID 输入和状态 notify。

**Tech Stack:** ESP-IDF 6.x、ESP32-S3、NimBLE、TinyUSB HID、Web Bluetooth、浏览器原生 JavaScript、HTML/CSS、Git。

---

## 已确认规格来源

实现必须遵守：

- `docs/superpowers/specs/2026-06-29-esp32s3-web-bluetooth-hid-input-design.md`
- 目标 Windows 必须启用 `EnableHexNumpad=1` 并重新登录。
- 控制端只支持桌面 Chrome/Edge。
- SDK 是纯浏览器单文件 JavaScript，不使用 npm 构建。
- 第一版无 BLE 鉴权。
- `typeText(text)` 最大 16 KB UTF-8，并等待固件输入完成。
- HID 按键动作固定保守延迟 20 ms。

## 执行前检查

在开始实现前，执行者先确认 ESP-IDF 6.x 环境可用：

```powershell
idf.py --version
```

期望输出包含 `ESP-IDF v6`。如果当前 shell 找不到 `idf.py`，先进入 ESP-IDF PowerShell 环境，或执行本机 ESP-IDF 6.x 的 `export.ps1`。当前仓库已经初始化 Git，提交前检查：

```powershell
git status --short
```

期望输出只包含当前任务相关改动。

## 文件结构

计划创建以下结构：

```text
firmware/
  CMakeLists.txt
  sdkconfig.defaults
  main/
    CMakeLists.txt
    app_main.c
    ai_input_protocol.h
    ai_input_protocol.c
    ai_input_status.h
    ai_input_status.c
    ai_input_task.h
    ai_input_task.c
    ai_input_utf8.h
    ai_input_utf8.c
    ai_input_hid.h
    ai_input_hid.c
    ai_input_ble.h
    ai_input_ble.c
web/
  ai-input-sdk.js
  index.html
  styles.css
tests/
  sdk-protocol.test.js
docs/
  windows-enable-hexnumpad.md
```

职责边界：

- `ai_input_protocol.*`：协议常量、帧格式、二进制编码/解析。
- `ai_input_status.*`：状态枚举、错误码、状态快照。
- `ai_input_task.*`：单 active task 缓冲、分片校验、提交。
- `ai_input_utf8.*`：UTF-8 解码为 Unicode scalar value。
- `ai_input_hid.*`：TinyUSB HID 初始化和 HexNumpad 输入序列。
- `ai_input_ble.*`：NimBLE GATT Service、Characteristic、广播、notify。
- `app_main.c`：初始化各模块，驱动主流程。
- `web/ai-input-sdk.js`：SDK 公共 API 和 BLE 协议实现。
- `tests/sdk-protocol.test.js`：SDK 协议编码、分包、状态解析的 Node 测试。
- `web/index.html`、`web/styles.css`：最小 demo 页面。
- `docs/windows-enable-hexnumpad.md`：目标 Windows 配置说明。

## 协议基线

两端使用固定 UUID：

```text
Service UUID: 9e7b0001-4f2a-4d3b-9c2a-0d6c9a120001
Control UUID: 9e7b0002-4f2a-4d3b-9c2a-0d6c9a120001
Data UUID:    9e7b0003-4f2a-4d3b-9c2a-0d6c9a120001
Status UUID:  9e7b0004-4f2a-4d3b-9c2a-0d6c9a120001
```

所有多字节整数使用 little-endian。

Control frame，长度 12 字节：

```text
byte 0:  version = 1
byte 1:  type, 1=start, 2=commit
byte 2:  taskId low
byte 3:  taskId high
byte 4:  totalBytes bit 0..7
byte 5:  totalBytes bit 8..15
byte 6:  totalBytes bit 16..23
byte 7:  totalBytes bit 24..31
byte 8:  totalChunks low
byte 9:  totalChunks high
byte 10: reserved = 0
byte 11: reserved = 0
```

Data frame，头部 8 字节，payload 12 字节以内。这个大小保证默认 BLE ATT 20 字节 payload 下也能工作：

```text
byte 0: version = 1
byte 1: type = 16
byte 2: taskId low
byte 3: taskId high
byte 4: chunkIndex low
byte 5: chunkIndex high
byte 6: totalChunks low
byte 7: totalChunks high
byte 8..19: payload
```

Status frame，长度 14 字节：

```text
byte 0:  version = 1
byte 1:  state, 0=idle, 1=receiving, 2=typing, 3=done, 4=error
byte 2:  lastTaskId low
byte 3:  lastTaskId high
byte 4:  lastErrorCode low
byte 5:  lastErrorCode high
byte 6:  receivedBytes bit 0..7
byte 7:  receivedBytes bit 8..15
byte 8:  receivedBytes bit 16..23
byte 9:  receivedBytes bit 24..31
byte 10: totalBytes bit 0..7
byte 11: totalBytes bit 8..15
byte 12: totalBytes bit 16..23
byte 13: totalBytes bit 24..31
```

错误码：

```text
0  OK
1  DEVICE_BUSY
2  INVALID_COMMAND
3  INVALID_CHUNK
4  DUPLICATE_CHUNK
5  MISSING_CHUNK
6  TASK_TOO_LARGE
7  INVALID_UTF8
8  INVALID_CODEPOINT
9  USB_NOT_READY
10 HID_INPUT_FAILED
```

---

### Task 1: 工程骨架与 Windows 配置文档

**Files:**
- Create: `firmware/CMakeLists.txt`
- Create: `firmware/sdkconfig.defaults`
- Create: `firmware/main/CMakeLists.txt`
- Create: `firmware/main/app_main.c`
- Create: `web/index.html`
- Create: `web/styles.css`
- Create: `docs/windows-enable-hexnumpad.md`

- [ ] **Step 1: 创建 ESP-IDF 工程骨架**

创建 `firmware/CMakeLists.txt`：

```cmake
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(ai_input)
```

创建 `firmware/main/CMakeLists.txt`：

```cmake
idf_component_register(
    SRCS
        "app_main.c"
    INCLUDE_DIRS "."
    REQUIRES
        bt
        nvs_flash
        esp_tinyusb
        tinyusb
)
```

创建 `firmware/main/app_main.c`：

```c
#include "esp_log.h"

static const char *TAG = "ai_input";

void app_main(void)
{
    ESP_LOGI(TAG, "AI Input firmware booting");
}
```

- [ ] **Step 2: 写入默认 sdkconfig**

创建 `firmware/sdkconfig.defaults`：

```text
CONFIG_IDF_TARGET="esp32s3"
CONFIG_BT_ENABLED=y
CONFIG_BT_NIMBLE_ENABLED=y
CONFIG_BT_NIMBLE_ROLE_PERIPHERAL=y
CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1
CONFIG_TINYUSB=y
CONFIG_TINYUSB_HID_ENABLED=y
CONFIG_LOG_DEFAULT_LEVEL_INFO=y
```

- [ ] **Step 3: 创建最小 demo 页面**

创建 `web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Input Demo</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="app">
    <section class="panel">
      <h1>AI Input</h1>
      <div class="toolbar">
        <button id="connectButton" type="button">连接</button>
        <button id="disconnectButton" type="button" disabled>断开</button>
        <button id="statusButton" type="button" disabled>状态</button>
      </div>
      <textarea id="textInput" rows="8" maxlength="16384" placeholder="输入要发送到目标 Windows 的文本"></textarea>
      <button id="typeButton" type="button" disabled>发送并等待输入完成</button>
      <pre id="statusOutput">未连接</pre>
    </section>
  </main>
  <script src="./ai-input-sdk.js"></script>
  <script>
    let device = null;
    const statusOutput = document.querySelector("#statusOutput");
    const connectButton = document.querySelector("#connectButton");
    const disconnectButton = document.querySelector("#disconnectButton");
    const statusButton = document.querySelector("#statusButton");
    const typeButton = document.querySelector("#typeButton");
    const textInput = document.querySelector("#textInput");

    function setConnected(value) {
      connectButton.disabled = value;
      disconnectButton.disabled = !value;
      statusButton.disabled = !value;
      typeButton.disabled = !value;
    }

    connectButton.addEventListener("click", async () => {
      try {
        device = await AIInput.connect();
        setConnected(true);
        statusOutput.textContent = "已连接";
      } catch (error) {
        statusOutput.textContent = `${error.code || "ERROR"}: ${error.message}`;
      }
    });

    disconnectButton.addEventListener("click", async () => {
      if (device) await device.disconnect();
      device = null;
      setConnected(false);
      statusOutput.textContent = "已断开";
    });

    statusButton.addEventListener("click", async () => {
      const status = await device.getStatus();
      statusOutput.textContent = JSON.stringify(status, null, 2);
    });

    typeButton.addEventListener("click", async () => {
      try {
        typeButton.disabled = true;
        await device.typeText(textInput.value);
        statusOutput.textContent = "输入完成";
      } catch (error) {
        statusOutput.textContent = `${error.code || "ERROR"}: ${error.message}`;
      } finally {
        typeButton.disabled = false;
      }
    });
  </script>
</body>
</html>
```

创建 `web/styles.css`：

```css
:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

body {
  margin: 0;
  background: #f4f6f8;
  color: #1f2933;
}

.app {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.panel {
  width: min(720px, 100%);
  display: grid;
  gap: 16px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

button {
  min-height: 40px;
  border: 1px solid #9aa5b1;
  border-radius: 6px;
  background: #ffffff;
  color: #1f2933;
  padding: 0 14px;
}

button:disabled {
  opacity: 0.5;
}

textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #9aa5b1;
  border-radius: 6px;
  padding: 12px;
  resize: vertical;
  font: inherit;
}

pre {
  min-height: 80px;
  border: 1px solid #cbd2d9;
  border-radius: 6px;
  background: #ffffff;
  padding: 12px;
  overflow: auto;
}
```

- [ ] **Step 4: 写 Windows 配置说明**

创建 `docs/windows-enable-hexnumpad.md`：

```markdown
# Windows EnableHexNumpad 配置

目标 Windows 必须开启 HexNumpad，ESP32-S3 才能通过 `Alt + 小键盘 + + 十六进制码点` 输入 Unicode。

## 注册表设置

1. 打开 `regedit`。
2. 进入 `HKEY_CURRENT_USER\Control Panel\Input Method`。
3. 新建或修改字符串值 `EnableHexNumpad`。
4. 设置值为 `1`。
5. 注销并重新登录，或重启电脑。

## 验证

打开 Notepad，按住 `Alt`，按小键盘 `+`，输入 `4E2D`，松开 `Alt`。如果出现 `中`，说明配置生效。
```

- [ ] **Step 5: 构建骨架**

执行：

```powershell
idf.py -C firmware set-target esp32s3
idf.py -C firmware build
```

期望：`Project build complete`。如果 ESP-IDF 环境未激活，先完成执行前检查。

- [ ] **Step 6: 提交**

```powershell
git add firmware web docs/windows-enable-hexnumpad.md
git commit -m "chore: scaffold firmware and web demo"
```

---

### Task 2: SDK 协议编码与状态解析

**Files:**
- Create: `web/ai-input-sdk.js`
- Create: `tests/sdk-protocol.test.js`

- [ ] **Step 1: 先写 SDK 协议测试**

创建 `tests/sdk-protocol.test.js`：

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("web/ai-input-sdk.js", "utf8");
const context = {
  window: {},
  navigator: {},
  TextEncoder,
  DataView,
  ArrayBuffer,
  Uint8Array,
  console,
};
vm.createContext(context);
vm.runInContext(source, context);

const internals = context.window.AIInput._internals;

{
  const frame = internals.encodeControlFrame(1, 7, 16, 2);
  assert.equal(frame.byteLength, 12);
  assert.deepEqual(Array.from(frame), [1, 1, 7, 0, 16, 0, 0, 0, 2, 0, 0, 0]);
}

{
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const chunks = internals.createDataFrames(9, bytes);
  assert.equal(chunks.length, 1);
  assert.deepEqual(Array.from(chunks[0]), [1, 16, 9, 0, 0, 0, 1, 0, 1, 2, 3, 4, 5]);
}

{
  const bytes = new Uint8Array(25);
  const chunks = internals.createDataFrames(3, bytes);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].byteLength, 20);
  assert.equal(chunks[1].byteLength, 20);
  assert.equal(chunks[2].byteLength, 9);
}

{
  const frame = new Uint8Array([1, 2, 12, 0, 0, 0, 0, 4, 0, 0, 0, 16, 0, 0]);
  const status = internals.decodeStatusFrame(frame.buffer);
  assert.deepEqual(status, {
    state: "typing",
    lastTaskId: 12,
    lastErrorCode: 0,
    receivedBytes: 1024,
    totalBytes: 4096,
  });
}

console.log("sdk protocol tests passed");
```

- [ ] **Step 2: 运行测试确认失败**

执行：

```powershell
node tests/sdk-protocol.test.js
```

期望失败，错误包含 `ENOENT` 或 `AIInput` 未定义。

- [ ] **Step 3: 实现协议工具**

创建 `web/ai-input-sdk.js`：

```js
(function attachAIInput(global) {
  "use strict";

  const SERVICE_UUID = "9e7b0001-4f2a-4d3b-9c2a-0d6c9a120001";
  const CONTROL_UUID = "9e7b0002-4f2a-4d3b-9c2a-0d6c9a120001";
  const DATA_UUID = "9e7b0003-4f2a-4d3b-9c2a-0d6c9a120001";
  const STATUS_UUID = "9e7b0004-4f2a-4d3b-9c2a-0d6c9a120001";

  const VERSION = 1;
  const CONTROL_START = 1;
  const CONTROL_COMMIT = 2;
  const DATA_FRAME = 16;
  const MAX_TEXT_BYTES = 16 * 1024;
  const DATA_PAYLOAD_BYTES = 12;

  const STATES = ["idle", "receiving", "typing", "done", "error"];

  class AIInputError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "AIInputError";
      this.code = code;
    }
  }

  function encodeControlFrame(type, taskId, totalBytes, totalChunks) {
    const frame = new ArrayBuffer(12);
    const view = new DataView(frame);
    view.setUint8(0, VERSION);
    view.setUint8(1, type);
    view.setUint16(2, taskId, true);
    view.setUint32(4, totalBytes, true);
    view.setUint16(8, totalChunks, true);
    view.setUint16(10, 0, true);
    return new Uint8Array(frame);
  }

  function createDataFrames(taskId, bytes) {
    const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / DATA_PAYLOAD_BYTES));
    const frames = [];
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * DATA_PAYLOAD_BYTES;
      const payload = bytes.slice(start, start + DATA_PAYLOAD_BYTES);
      const frame = new Uint8Array(8 + payload.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint8(0, VERSION);
      view.setUint8(1, DATA_FRAME);
      view.setUint16(2, taskId, true);
      view.setUint16(4, chunkIndex, true);
      view.setUint16(6, totalChunks, true);
      frame.set(payload, 8);
      frames.push(frame);
    }
    return frames;
  }

  function decodeStatusFrame(buffer) {
    const view = buffer instanceof DataView ? buffer : new DataView(buffer);
    if (view.byteLength !== 14 || view.getUint8(0) !== VERSION) {
      throw new AIInputError("INVALID_STATUS_FRAME", "Invalid status frame");
    }
    const stateCode = view.getUint8(1);
    return {
      state: STATES[stateCode] || "error",
      lastTaskId: view.getUint16(2, true),
      lastErrorCode: view.getUint16(4, true),
      receivedBytes: view.getUint32(6, true),
      totalBytes: view.getUint32(10, true),
    };
  }

  const AIInput = {
    connect,
    AIInputError,
    _internals: {
      encodeControlFrame,
      createDataFrames,
      decodeStatusFrame,
      constants: {
        SERVICE_UUID,
        CONTROL_UUID,
        DATA_UUID,
        STATUS_UUID,
        CONTROL_START,
        CONTROL_COMMIT,
        MAX_TEXT_BYTES,
      },
    },
  };

  async function connect() {
    throw new AIInputError("WEB_BLUETOOTH_UNSUPPORTED", "Connection is implemented in the next task");
  }

  global.AIInput = AIInput;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
node tests/sdk-protocol.test.js
```

期望输出：

```text
sdk protocol tests passed
```

- [ ] **Step 5: 提交**

```powershell
git add web/ai-input-sdk.js tests/sdk-protocol.test.js
git commit -m "test: add sdk protocol encoding"
```

---

### Task 3: SDK Web Bluetooth 连接与 typeText 流程

**Files:**
- Modify: `web/ai-input-sdk.js`
- Modify: `tests/sdk-protocol.test.js`

- [ ] **Step 1: 扩展测试覆盖文本长度和状态错误**

在 `tests/sdk-protocol.test.js` 末尾追加：

```js
{
  const oversized = new Uint8Array((16 * 1024) + 1);
  assert.throws(
    () => internals.assertTextSize(oversized),
    /TEXT_TOO_LARGE/
  );
}

{
  const valid = new Uint8Array(16 * 1024);
  assert.equal(internals.assertTextSize(valid), undefined);
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
node tests/sdk-protocol.test.js
```

期望失败，错误包含 `assertTextSize is not a function`。

- [ ] **Step 3: 实现 SDK 连接、状态读取、发送任务**

在 `web/ai-input-sdk.js` 中加入 `AIInputDevice` 类，并把 `connect()` 替换为真实实现。保留 Task 2 中的协议函数，新增以下代码：

```js
  function assertTextSize(bytes) {
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      throw new AIInputError("TEXT_TOO_LARGE", "Text exceeds 16 KB UTF-8 limit");
    }
  }

  class AIInputDevice {
    constructor(device, server, controlChar, dataChar, statusChar) {
      this.device = device;
      this.server = server;
      this.controlChar = controlChar;
      this.dataChar = dataChar;
      this.statusChar = statusChar;
      this.taskId = 1;
      this.pending = null;
      this.connected = true;
      this._onDisconnected = this._onDisconnected.bind(this);
      this._onStatusChanged = this._onStatusChanged.bind(this);
      this.device.addEventListener("gattserverdisconnected", this._onDisconnected);
    }

    async startNotifications() {
      await this.statusChar.startNotifications();
      this.statusChar.addEventListener("characteristicvaluechanged", this._onStatusChanged);
    }

    async typeText(text) {
      if (!this.connected) throw new AIInputError("NOT_CONNECTED", "Device is not connected");
      if (this.pending) throw new AIInputError("CLIENT_BUSY", "A typeText call is already pending");

      const bytes = new TextEncoder().encode(text);
      assertTextSize(bytes);
      const taskId = this.taskId;
      this.taskId = (this.taskId % 65535) + 1;

      const frames = createDataFrames(taskId, bytes);
      const start = encodeControlFrame(CONTROL_START, taskId, bytes.byteLength, frames.length);
      const commit = encodeControlFrame(CONTROL_COMMIT, taskId, bytes.byteLength, frames.length);

      const completion = new Promise((resolve, reject) => {
        this.pending = { taskId, resolve, reject };
      });

      try {
        await this.controlChar.writeValueWithResponse(start);
        for (const frame of frames) {
          await this.dataChar.writeValueWithResponse(frame);
        }
        await this.controlChar.writeValueWithResponse(commit);
      } catch (error) {
        const pending = this.pending;
        this.pending = null;
        pending.reject(new AIInputError("BLE_WRITE_FAILED", error.message));
      }

      return completion;
    }

    async getStatus() {
      if (!this.connected) throw new AIInputError("NOT_CONNECTED", "Device is not connected");
      const value = await this.statusChar.readValue();
      return decodeStatusFrame(value);
    }

    async disconnect() {
      this.connected = false;
      if (this.pending) {
        this.pending.reject(new AIInputError("DISCONNECTED", "Device disconnected"));
        this.pending = null;
      }
      try {
        this.statusChar.removeEventListener("characteristicvaluechanged", this._onStatusChanged);
        await this.statusChar.stopNotifications();
      } catch (_) {
        // Ignore cleanup errors during disconnect.
      }
      this.device.removeEventListener("gattserverdisconnected", this._onDisconnected);
      if (this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
    }

    _onStatusChanged(event) {
      const status = decodeStatusFrame(event.target.value);
      if (!this.pending || status.lastTaskId !== this.pending.taskId) return;
      if (status.state === "done") {
        const pending = this.pending;
        this.pending = null;
        pending.resolve(status);
      }
      if (status.state === "error") {
        const pending = this.pending;
        this.pending = null;
        pending.reject(new AIInputError(`DEVICE_ERROR_${status.lastErrorCode}`, "Device returned an error"));
      }
    }

    _onDisconnected() {
      this.connected = false;
      if (this.pending) {
        this.pending.reject(new AIInputError("DISCONNECTED", "Device disconnected"));
        this.pending = null;
      }
    }
  }

  async function connect() {
    if (!navigator.bluetooth) {
      throw new AIInputError("WEB_BLUETOOTH_UNSUPPORTED", "Web Bluetooth is not available");
    }
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });
    } catch (error) {
      throw new AIInputError("DEVICE_SELECTION_CANCELLED", error.message);
    }
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const controlChar = await service.getCharacteristic(CONTROL_UUID);
    const dataChar = await service.getCharacteristic(DATA_UUID);
    const statusChar = await service.getCharacteristic(STATUS_UUID);
    const aiDevice = new AIInputDevice(device, server, controlChar, dataChar, statusChar);
    await aiDevice.startNotifications();
    return aiDevice;
  }
```

把 `_internals` 扩展为：

```js
      assertTextSize,
```

- [ ] **Step 4: 运行测试**

```powershell
node tests/sdk-protocol.test.js
```

期望输出：

```text
sdk protocol tests passed
```

- [ ] **Step 5: 手动检查 demo 引用**

执行：

```powershell
Start-Process "msedge.exe" "$PWD\web\index.html"
```

期望：页面能打开，未连接时按钮状态正确。没有硬件时不要求连接成功。

- [ ] **Step 6: 提交**

```powershell
git add web/ai-input-sdk.js tests/sdk-protocol.test.js web/index.html web/styles.css
git commit -m "feat: add web bluetooth sdk flow"
```

---

### Task 4: 固件协议、状态和任务缓冲

**Files:**
- Create: `firmware/main/ai_input_protocol.h`
- Create: `firmware/main/ai_input_protocol.c`
- Create: `firmware/main/ai_input_status.h`
- Create: `firmware/main/ai_input_status.c`
- Create: `firmware/main/ai_input_task.h`
- Create: `firmware/main/ai_input_task.c`
- Modify: `firmware/main/CMakeLists.txt`

- [ ] **Step 1: 写协议头文件**

创建 `firmware/main/ai_input_protocol.h`：

```c
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AI_INPUT_PROTOCOL_VERSION 1
#define AI_INPUT_MAX_TEXT_BYTES (16 * 1024)
#define AI_INPUT_DATA_PAYLOAD_BYTES 12
#define AI_INPUT_CONTROL_FRAME_LEN 12
#define AI_INPUT_DATA_FRAME_HEADER_LEN 8
#define AI_INPUT_STATUS_FRAME_LEN 14

typedef enum {
    AI_INPUT_CONTROL_START = 1,
    AI_INPUT_CONTROL_COMMIT = 2,
    AI_INPUT_DATA_FRAME = 16,
} ai_input_frame_type_t;

typedef struct {
    uint8_t type;
    uint16_t task_id;
    uint32_t total_bytes;
    uint16_t total_chunks;
} ai_input_control_frame_t;

typedef struct {
    uint16_t task_id;
    uint16_t chunk_index;
    uint16_t total_chunks;
    const uint8_t *payload;
    size_t payload_len;
} ai_input_data_frame_t;

bool ai_input_parse_control_frame(const uint8_t *data, size_t len, ai_input_control_frame_t *out);
bool ai_input_parse_data_frame(const uint8_t *data, size_t len, ai_input_data_frame_t *out);
```

- [ ] **Step 2: 写状态头文件**

创建 `firmware/main/ai_input_status.h`：

```c
#pragma once

#include <stdint.h>

typedef enum {
    AI_INPUT_STATE_IDLE = 0,
    AI_INPUT_STATE_RECEIVING = 1,
    AI_INPUT_STATE_TYPING = 2,
    AI_INPUT_STATE_DONE = 3,
    AI_INPUT_STATE_ERROR = 4,
} ai_input_state_t;

typedef enum {
    AI_INPUT_ERR_OK = 0,
    AI_INPUT_ERR_DEVICE_BUSY = 1,
    AI_INPUT_ERR_INVALID_COMMAND = 2,
    AI_INPUT_ERR_INVALID_CHUNK = 3,
    AI_INPUT_ERR_DUPLICATE_CHUNK = 4,
    AI_INPUT_ERR_MISSING_CHUNK = 5,
    AI_INPUT_ERR_TASK_TOO_LARGE = 6,
    AI_INPUT_ERR_INVALID_UTF8 = 7,
    AI_INPUT_ERR_INVALID_CODEPOINT = 8,
    AI_INPUT_ERR_USB_NOT_READY = 9,
    AI_INPUT_ERR_HID_INPUT_FAILED = 10,
} ai_input_error_t;

typedef struct {
    ai_input_state_t state;
    uint16_t last_task_id;
    ai_input_error_t last_error;
    uint32_t received_bytes;
    uint32_t total_bytes;
} ai_input_status_t;

void ai_input_status_init(void);
void ai_input_status_set(ai_input_state_t state, uint16_t task_id, ai_input_error_t error, uint32_t received, uint32_t total);
ai_input_status_t ai_input_status_get(void);
void ai_input_status_encode(uint8_t out[14]);
```

- [ ] **Step 3: 实现协议解析和状态编码**

创建 `firmware/main/ai_input_protocol.c` 和 `firmware/main/ai_input_status.c`，关键行为：

```c
static uint16_t read_le16(const uint8_t *p)
{
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t read_le32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
```

`ai_input_parse_control_frame()` 必须校验：

```c
len == AI_INPUT_CONTROL_FRAME_LEN
data[0] == AI_INPUT_PROTOCOL_VERSION
type == AI_INPUT_CONTROL_START || type == AI_INPUT_CONTROL_COMMIT
total_bytes <= AI_INPUT_MAX_TEXT_BYTES
total_chunks > 0
data[10] == 0 && data[11] == 0
```

`ai_input_parse_data_frame()` 必须校验：

```c
len >= AI_INPUT_DATA_FRAME_HEADER_LEN
len <= AI_INPUT_DATA_FRAME_HEADER_LEN + AI_INPUT_DATA_PAYLOAD_BYTES
data[0] == AI_INPUT_PROTOCOL_VERSION
data[1] == AI_INPUT_DATA_FRAME
total_chunks > 0
payload_len > 0 || total_chunks == 1
```

`ai_input_status_encode()` 按协议基线写 14 字节。

- [ ] **Step 4: 实现任务缓冲接口**

创建 `firmware/main/ai_input_task.h`：

```c
#pragma once

#include <stddef.h>
#include <stdint.h>
#include "ai_input_protocol.h"
#include "ai_input_status.h"

typedef struct {
    uint16_t task_id;
    uint32_t total_bytes;
    uint16_t total_chunks;
    uint32_t received_bytes;
    uint16_t received_chunks;
    uint8_t buffer[AI_INPUT_MAX_TEXT_BYTES];
    uint8_t chunk_seen[(AI_INPUT_MAX_TEXT_BYTES / AI_INPUT_DATA_PAYLOAD_BYTES) + 2];
    bool active;
} ai_input_task_buffer_t;

void ai_input_task_init(ai_input_task_buffer_t *task);
ai_input_error_t ai_input_task_start(ai_input_task_buffer_t *task, const ai_input_control_frame_t *frame);
ai_input_error_t ai_input_task_add_chunk(ai_input_task_buffer_t *task, const ai_input_data_frame_t *frame);
ai_input_error_t ai_input_task_commit(ai_input_task_buffer_t *task, const ai_input_control_frame_t *frame, const uint8_t **bytes, size_t *len);
void ai_input_task_reset(ai_input_task_buffer_t *task);
```

`ai_input_task.c` 行为：

- `start` 时如果 `active` 为 true，返回 `AI_INPUT_ERR_DEVICE_BUSY`。
- `start` 时清零 `chunk_seen`，设置 `active=true`。
- `add_chunk` 校验 taskId、totalChunks、chunkIndex。
- `add_chunk` 用 `offset = chunkIndex * AI_INPUT_DATA_PAYLOAD_BYTES` 复制 payload。
- 最后一个分片允许 payload 小于 12 字节。
- 重复分片返回 `AI_INPUT_ERR_DUPLICATE_CHUNK`。
- `commit` 校验 taskId、总长度、分片数量、所有分片已收齐。
- `commit` 成功时返回完整 `bytes` 和 `len`，不立即 reset，由调用方输入完成后 reset。

- [ ] **Step 5: 更新 CMake 并构建**

修改 `firmware/main/CMakeLists.txt`：

```cmake
idf_component_register(
    SRCS
        "app_main.c"
        "ai_input_protocol.c"
        "ai_input_status.c"
        "ai_input_task.c"
    INCLUDE_DIRS "."
    REQUIRES
        bt
        nvs_flash
        esp_tinyusb
        tinyusb
)
```

执行：

```powershell
idf.py -C firmware build
```

期望：`Project build complete`。

- [ ] **Step 6: 提交**

```powershell
git add firmware/main
git commit -m "feat: add firmware protocol task buffer"
```

---

### Task 5: UTF-8 解码模块

**Files:**
- Create: `firmware/main/ai_input_utf8.h`
- Create: `firmware/main/ai_input_utf8.c`
- Modify: `firmware/main/CMakeLists.txt`

- [ ] **Step 1: 写 UTF-8 接口**

创建 `firmware/main/ai_input_utf8.h`：

```c
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef bool (*ai_input_codepoint_cb_t)(uint32_t codepoint, void *ctx);

bool ai_input_utf8_decode_each(const uint8_t *bytes, size_t len, ai_input_codepoint_cb_t cb, void *ctx);
```

- [ ] **Step 2: 实现严格 UTF-8 解码**

创建 `firmware/main/ai_input_utf8.c`，实现规则：

```c
#include "ai_input_utf8.h"

static bool is_scalar(uint32_t cp)
{
    return cp <= 0x10FFFFu && !(cp >= 0xD800u && cp <= 0xDFFFu);
}
```

解码逻辑必须满足：

- 1 字节：`00..7F`
- 2 字节：首字节 `C2..DF`，第二字节 `80..BF`
- 3 字节：拒绝过长编码和 surrogate 区间
- 4 字节：最大 `U+10FFFF`
- 遇到非法字节直接返回 `false`
- 每个合法码点调用 `cb(codepoint, ctx)`；回调返回 false 时整体返回 false

用于 3 字节和 4 字节的边界判断：

```c
if (b0 == 0xE0 && b1 < 0xA0) return false;
if (b0 == 0xED && b1 >= 0xA0) return false;
if (b0 == 0xF0 && b1 < 0x90) return false;
if (b0 == 0xF4 && b1 > 0x8F) return false;
```

- [ ] **Step 3: 临时接入 app_main 做启动自检**

在 `app_main.c` 中临时加入一个小自检，构建期先验证函数可链接：

```c
#include "ai_input_utf8.h"

static bool count_codepoint(uint32_t codepoint, void *ctx)
{
    (void)codepoint;
    int *count = (int *)ctx;
    *count += 1;
    return true;
}
```

在 `app_main()` 中加入：

```c
const uint8_t sample[] = { 'H', 'i', ' ', 0xE4, 0xB8, 0xAD };
int count = 0;
bool ok = ai_input_utf8_decode_each(sample, sizeof(sample), count_codepoint, &count);
ESP_LOGI(TAG, "UTF-8 self check ok=%d count=%d", ok, count);
```

- [ ] **Step 4: 更新 CMake 并构建**

把 `ai_input_utf8.c` 加入 `firmware/main/CMakeLists.txt` 的 `SRCS`。

执行：

```powershell
idf.py -C firmware build
```

期望：`Project build complete`。

- [ ] **Step 5: 提交**

```powershell
git add firmware/main
git commit -m "feat: add utf8 decoder"
```

---

### Task 6: HID HexNumpad 输入模块

**Files:**
- Create: `firmware/main/ai_input_hid.h`
- Create: `firmware/main/ai_input_hid.c`
- Modify: `firmware/main/CMakeLists.txt`
- Modify: `firmware/main/app_main.c`

- [ ] **Step 1: 写 HID 接口**

创建 `firmware/main/ai_input_hid.h`：

```c
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#define AI_INPUT_HID_DELAY_MS 20

esp_err_t ai_input_hid_init(void);
bool ai_input_hid_ready(void);
esp_err_t ai_input_hid_type_codepoint(uint32_t codepoint);
```

- [ ] **Step 2: 实现 TinyUSB 初始化**

创建 `firmware/main/ai_input_hid.c`，包含：

```c
#include "ai_input_hid.h"
#include "class/hid/hid_device.h"
#include "esp_check.h"
#include "esp_log.h"
#include "tinyusb.h"
#include "tusb.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ai_input_hid";
static const uint8_t REPORT_ID_KEYBOARD = 1;

esp_err_t ai_input_hid_init(void)
{
    const tinyusb_config_t tusb_cfg = {
        .device_descriptor = NULL,
        .string_descriptor = NULL,
        .external_phy = false,
        .configuration_descriptor = NULL,
    };
    ESP_RETURN_ON_ERROR(tinyusb_driver_install(&tusb_cfg), TAG, "tinyusb install failed");
    return ESP_OK;
}

bool ai_input_hid_ready(void)
{
    return tud_mounted();
}
```

- [ ] **Step 3: 实现按键发送工具**

在同一文件中加入：

```c
static esp_err_t send_key(uint8_t modifier, uint8_t keycode)
{
    if (!tud_hid_ready()) return ESP_ERR_INVALID_STATE;
    uint8_t keys[6] = { keycode, 0, 0, 0, 0, 0 };
    tud_hid_keyboard_report(REPORT_ID_KEYBOARD, modifier, keys);
    vTaskDelay(pdMS_TO_TICKS(AI_INPUT_HID_DELAY_MS));
    tud_hid_keyboard_report(REPORT_ID_KEYBOARD, 0, NULL);
    vTaskDelay(pdMS_TO_TICKS(AI_INPUT_HID_DELAY_MS));
    return ESP_OK;
}

static uint8_t hex_keycode(char c)
{
    if (c >= '0' && c <= '9') return HID_KEY_0 + (uint8_t)(c - '0');
    if (c >= 'A' && c <= 'F') return HID_KEY_A + (uint8_t)(c - 'A');
    return 0;
}
```

- [ ] **Step 4: 实现单码点输入**

加入：

```c
esp_err_t ai_input_hid_type_codepoint(uint32_t codepoint)
{
    if (!ai_input_hid_ready()) return ESP_ERR_INVALID_STATE;
    if (codepoint > 0x10FFFFu || (codepoint >= 0xD800u && codepoint <= 0xDFFFu)) {
        return ESP_ERR_INVALID_ARG;
    }

    char hex[9] = {0};
    snprintf(hex, sizeof(hex), "%lX", (unsigned long)codepoint);

    uint8_t plus_keys[6] = { HID_KEY_KEYPAD_ADD, 0, 0, 0, 0, 0 };
    tud_hid_keyboard_report(REPORT_ID_KEYBOARD, KEYBOARD_MODIFIER_LEFTALT, plus_keys);
    vTaskDelay(pdMS_TO_TICKS(AI_INPUT_HID_DELAY_MS));

    for (const char *p = hex; *p; ++p) {
        uint8_t key = hex_keycode(*p);
        if (key == 0) {
            tud_hid_keyboard_report(REPORT_ID_KEYBOARD, 0, NULL);
            return ESP_ERR_INVALID_ARG;
        }
        uint8_t keys[6] = { key, 0, 0, 0, 0, 0 };
        tud_hid_keyboard_report(REPORT_ID_KEYBOARD, KEYBOARD_MODIFIER_LEFTALT, keys);
        vTaskDelay(pdMS_TO_TICKS(AI_INPUT_HID_DELAY_MS));
        tud_hid_keyboard_report(REPORT_ID_KEYBOARD, KEYBOARD_MODIFIER_LEFTALT, NULL);
        vTaskDelay(pdMS_TO_TICKS(AI_INPUT_HID_DELAY_MS));
    }

    tud_hid_keyboard_report(REPORT_ID_KEYBOARD, 0, NULL);
    vTaskDelay(pdMS_TO_TICKS(AI_INPUT_HID_DELAY_MS));
    return ESP_OK;
}
```

- [ ] **Step 5: 加入 TinyUSB HID callbacks**

在 `ai_input_hid.c` 中加入 TinyUSB 需要的回调：

```c
uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type, uint8_t *buffer, uint16_t reqlen)
{
    (void)instance;
    (void)report_id;
    (void)report_type;
    (void)buffer;
    (void)reqlen;
    return 0;
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type, uint8_t const *buffer, uint16_t bufsize)
{
    (void)instance;
    (void)report_id;
    (void)report_type;
    (void)buffer;
    (void)bufsize;
}
```

- [ ] **Step 6: 接入 app_main 并构建**

在 `app_main.c` 初始化调用：

```c
#include "ai_input_hid.h"

ESP_ERROR_CHECK(ai_input_hid_init());
ESP_LOGI(TAG, "HID initialized");
```

把 `ai_input_hid.c` 加入 CMake `SRCS`。

执行：

```powershell
idf.py -C firmware build
```

期望：`Project build complete`。

- [ ] **Step 7: 提交**

```powershell
git add firmware/main
git commit -m "feat: add hid hexnumpad output"
```

---

### Task 7: BLE GATT Server

**Files:**
- Create: `firmware/main/ai_input_ble.h`
- Create: `firmware/main/ai_input_ble.c`
- Modify: `firmware/main/CMakeLists.txt`
- Modify: `firmware/main/app_main.c`

- [ ] **Step 1: 写 BLE 接口**

创建 `firmware/main/ai_input_ble.h`：

```c
#pragma once

#include "esp_err.h"
#include "ai_input_protocol.h"
#include "ai_input_status.h"

typedef void (*ai_input_control_cb_t)(const ai_input_control_frame_t *frame);
typedef void (*ai_input_data_cb_t)(const ai_input_data_frame_t *frame);

typedef struct {
    ai_input_control_cb_t on_control;
    ai_input_data_cb_t on_data;
} ai_input_ble_callbacks_t;

esp_err_t ai_input_ble_init(const ai_input_ble_callbacks_t *callbacks);
void ai_input_ble_notify_status(void);
```

- [ ] **Step 2: 实现 BLE 初始化骨架**

创建 `firmware/main/ai_input_ble.c`，初始化顺序必须是：

```c
nvs_flash_init();
nimble_port_init();
ble_svc_gap_device_name_set("AI-Input-S3");
ble_svc_gap_init();
ble_svc_gatt_init();
ble_gatts_count_cfg(gatt_svcs);
ble_gatts_add_svcs(gatt_svcs);
nimble_port_freertos_init(host_task);
```

如果 `nvs_flash_init()` 返回 `ESP_ERR_NVS_NO_FREE_PAGES` 或 `ESP_ERR_NVS_NEW_VERSION_FOUND`，先擦除 NVS 再初始化：

```c
ESP_ERROR_CHECK(nvs_flash_erase());
ESP_ERROR_CHECK(nvs_flash_init());
```

- [ ] **Step 3: 定义 UUID 和 Characteristic**

在 `ai_input_ble.c` 定义 128-bit UUID。使用 NimBLE 的 `BLE_UUID128_INIT`，注意字节序按 NimBLE 要求写入。三个 characteristic 权限：

```c
Control: BLE_GATT_CHR_F_WRITE
Data:    BLE_GATT_CHR_F_WRITE
Status:  BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY
```

Control write handler：

- 读取 `ctxt->om` 到连续 buffer。
- 调用 `ai_input_parse_control_frame()`。
- 成功时调用 `callbacks.on_control(&frame)`。
- 失败时设置状态为 `AI_INPUT_STATE_ERROR` + `AI_INPUT_ERR_INVALID_COMMAND` 并 notify。

Data write handler：

- 调用 `ai_input_parse_data_frame()`。
- 成功时调用 `callbacks.on_data(&frame)`。
- 失败时设置状态为 `AI_INPUT_STATE_ERROR` + `AI_INPUT_ERR_INVALID_CHUNK` 并 notify。

Status read handler：

```c
uint8_t status[AI_INPUT_STATUS_FRAME_LEN];
ai_input_status_encode(status);
os_mbuf_append(ctxt->om, status, sizeof(status));
return 0;
```

- [ ] **Step 4: 实现广播**

广播参数：

```c
fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
fields.name = (uint8_t *)"AI-Input-S3";
fields.name_len = strlen("AI-Input-S3");
fields.name_is_complete = 1;
fields.uuids128 = &service_uuid.u;
fields.num_uuids128 = 1;
fields.uuids128_is_complete = 1;
```

连接断开后重新开始广播。

- [ ] **Step 5: 实现 status notify**

保存当前连接 handle 和 status characteristic value handle。`ai_input_ble_notify_status()`：

```c
if (conn_handle != BLE_HS_CONN_HANDLE_NONE && status_val_handle != 0) {
    uint8_t status[AI_INPUT_STATUS_FRAME_LEN];
    ai_input_status_encode(status);
    struct os_mbuf *om = ble_hs_mbuf_from_flat(status, sizeof(status));
    ble_gatts_notify_custom(conn_handle, status_val_handle, om);
}
```

- [ ] **Step 6: 接入 app_main 并构建**

在 `app_main.c` 创建 callbacks，但先只记录日志：

```c
static void on_control(const ai_input_control_frame_t *frame)
{
    ESP_LOGI(TAG, "control type=%u task=%u", frame->type, frame->task_id);
}

static void on_data(const ai_input_data_frame_t *frame)
{
    ESP_LOGI(TAG, "data task=%u chunk=%u", frame->task_id, frame->chunk_index);
}
```

初始化：

```c
const ai_input_ble_callbacks_t callbacks = {
    .on_control = on_control,
    .on_data = on_data,
};
ESP_ERROR_CHECK(ai_input_ble_init(&callbacks));
```

把 `ai_input_ble.c` 加入 CMake `SRCS`。

执行：

```powershell
idf.py -C firmware build
```

期望：`Project build complete`。

- [ ] **Step 7: 提交**

```powershell
git add firmware/main
git commit -m "feat: add ble gatt server"
```

---

### Task 8: 固件主流程集成

**Files:**
- Modify: `firmware/main/app_main.c`
- Modify: `firmware/main/ai_input_status.c`
- Modify: `firmware/main/ai_input_task.c`

- [ ] **Step 1: 定义主流程状态**

在 `app_main.c` 文件顶部加入：

```c
static ai_input_task_buffer_t g_task;
static const uint8_t *g_pending_bytes = NULL;
static size_t g_pending_len = 0;
```

- [ ] **Step 2: 实现码点输入回调**

在 `app_main.c` 中加入：

```c
static bool type_codepoint_cb(uint32_t codepoint, void *ctx)
{
    (void)ctx;
    esp_err_t err = ai_input_hid_type_codepoint(codepoint);
    return err == ESP_OK;
}
```

- [ ] **Step 3: 实现任务执行函数**

在 `app_main.c` 中加入：

```c
static void run_typing_task(uint16_t task_id, const uint8_t *bytes, size_t len)
{
    ai_input_status_set(AI_INPUT_STATE_TYPING, task_id, AI_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);
    ai_input_ble_notify_status();

    if (!ai_input_hid_ready()) {
        ai_input_status_set(AI_INPUT_STATE_ERROR, task_id, AI_INPUT_ERR_USB_NOT_READY, (uint32_t)len, (uint32_t)len);
        ai_input_ble_notify_status();
        ai_input_task_reset(&g_task);
        return;
    }

    bool ok = ai_input_utf8_decode_each(bytes, len, type_codepoint_cb, NULL);
    if (!ok) {
        ai_input_status_set(AI_INPUT_STATE_ERROR, task_id, AI_INPUT_ERR_INVALID_UTF8, (uint32_t)len, (uint32_t)len);
        ai_input_ble_notify_status();
        ai_input_task_reset(&g_task);
        return;
    }

    ai_input_status_set(AI_INPUT_STATE_DONE, task_id, AI_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);
    ai_input_ble_notify_status();
    ai_input_task_reset(&g_task);
}
```

- [ ] **Step 4: 实现 Control callback**

替换 Task 7 的 `on_control`：

```c
static void on_control(const ai_input_control_frame_t *frame)
{
    ai_input_error_t err = AI_INPUT_ERR_OK;

    if (frame->type == AI_INPUT_CONTROL_START) {
        err = ai_input_task_start(&g_task, frame);
        if (err == AI_INPUT_ERR_OK) {
            ai_input_status_set(AI_INPUT_STATE_RECEIVING, frame->task_id, AI_INPUT_ERR_OK, 0, frame->total_bytes);
        } else {
            ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, err, 0, frame->total_bytes);
        }
        ai_input_ble_notify_status();
        return;
    }

    if (frame->type == AI_INPUT_CONTROL_COMMIT) {
        err = ai_input_task_commit(&g_task, frame, &g_pending_bytes, &g_pending_len);
        if (err != AI_INPUT_ERR_OK) {
            ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, err, g_task.received_bytes, frame->total_bytes);
            ai_input_ble_notify_status();
            ai_input_task_reset(&g_task);
            return;
        }
        run_typing_task(frame->task_id, g_pending_bytes, g_pending_len);
        return;
    }

    ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, AI_INPUT_ERR_INVALID_COMMAND, 0, frame->total_bytes);
    ai_input_ble_notify_status();
}
```

- [ ] **Step 5: 实现 Data callback**

替换 Task 7 的 `on_data`：

```c
static void on_data(const ai_input_data_frame_t *frame)
{
    ai_input_error_t err = ai_input_task_add_chunk(&g_task, frame);
    if (err == AI_INPUT_ERR_OK) {
        ai_input_status_set(AI_INPUT_STATE_RECEIVING, frame->task_id, AI_INPUT_ERR_OK, g_task.received_bytes, g_task.total_bytes);
    } else {
        ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, err, g_task.received_bytes, g_task.total_bytes);
    }
    ai_input_ble_notify_status();
}
```

- [ ] **Step 6: 初始化顺序**

`app_main()` 初始化顺序调整为：

```c
ai_input_status_init();
ai_input_task_init(&g_task);
ESP_ERROR_CHECK(ai_input_hid_init());
const ai_input_ble_callbacks_t callbacks = {
    .on_control = on_control,
    .on_data = on_data,
};
ESP_ERROR_CHECK(ai_input_ble_init(&callbacks));
ESP_LOGI(TAG, "AI Input ready");
```

移除 Task 5 的临时 UTF-8 自检日志。

- [ ] **Step 7: 构建**

```powershell
idf.py -C firmware build
```

期望：`Project build complete`。

- [ ] **Step 8: 提交**

```powershell
git add firmware/main
git commit -m "feat: wire firmware input flow"
```

---

### Task 9: 端到端验证与收尾文档

**Files:**
- Create: `README.md`
- Modify: `docs/windows-enable-hexnumpad.md`
- Modify: `web/index.html`

- [ ] **Step 1: 写 README**

创建 `README.md`：

```markdown
# AI Input

AI Input 使用 ESP32-S3 作为 BLE 到 USB HID 的输入桥。控制端桌面 Chrome/Edge 通过 Web Bluetooth 发送文本，ESP32-S3 插在目标 Windows 上并模拟 HID 键盘输入 Unicode。

## 前置条件

- ESP32-S3。
- ESP-IDF 6.x。
- 控制端桌面 Chrome 或 Edge。
- 目标 Windows 已启用 `EnableHexNumpad=1` 并重新登录。

## 构建固件

```powershell
idf.py -C firmware set-target esp32s3
idf.py -C firmware build
idf.py -C firmware flash
```

## 使用 demo

1. 把 ESP32-S3 插到目标 Windows。
2. 打开 Notepad 并把光标放入文本区。
3. 在控制端 Chrome/Edge 打开 `web/index.html`。
4. 点击连接，选择 `AI-Input-S3`。
5. 输入文本并点击发送。

## 限制

- 第一版无 BLE 鉴权，只适合受控环境。
- `typeText()` 最大 16 KB UTF-8。
- ESP32-S3 无法确认目标应用是否实际收到字符。
- 不同 Windows 应用对 HexNumpad 的支持可能不同，第一版以 Notepad 为验收基准。
```

- [ ] **Step 2: 补充 demo 前置提示**

在 `web/index.html` 的 `<section class="panel">` 内、textarea 前加入：

```html
<p class="hint">目标 Windows 需要先启用 EnableHexNumpad，并把光标放到 Notepad 或标准文本框中。</p>
```

在 `web/styles.css` 加入：

```css
.hint {
  margin: 0;
  color: #52606d;
  line-height: 1.5;
}
```

- [ ] **Step 3: SDK 协议测试**

```powershell
node tests/sdk-protocol.test.js
```

期望：

```text
sdk protocol tests passed
```

- [ ] **Step 4: 固件构建**

```powershell
idf.py -C firmware build
```

期望：`Project build complete`。

- [ ] **Step 5: 实机验证**

烧录：

```powershell
idf.py -C firmware flash
```

实机检查：

- 目标 Windows 设备管理器中出现 HID 键盘。
- 控制端 Chrome/Edge 能发现 `AI-Input-S3`。
- demo 连接成功。
- Notepad 中发送 `Hello` 后出现 `Hello`。
- Notepad 中发送 `你好` 后出现 `你好`。
- Notepad 中发送 `😀` 后出现 `😀`。
- Notepad 中发送 `Hello 你好 😀` 后出现同样文本。
- 超过 16 KB UTF-8 文本在 SDK 本地返回 `TEXT_TOO_LARGE`。

- [ ] **Step 6: 最终状态检查**

```powershell
git status --short
git log --oneline -5
```

期望：只有本任务相关未提交文件，最近提交能看出每个任务的边界。

- [ ] **Step 7: 提交**

```powershell
git add README.md docs/windows-enable-hexnumpad.md web/index.html web/styles.css
git commit -m "docs: add usage and verification guide"
```

## 计划自检记录

规格覆盖：

- ESP-IDF 6.x 固件：Task 1、4、5、6、7、8。
- BLE GATT Server：Task 7、8。
- TinyUSB HID Keyboard：Task 6、8。
- 纯浏览器 JS SDK：Task 2、3。
- Demo 页面：Task 1、9。
- 16 KB UTF-8 限制：Task 2、3、4、8。
- `typeText()` 等待完成：Task 3、7、8。
- 简单状态：Task 2、3、4、7、8。
- Windows HexNumpad 前置条件：Task 1、9。
- 端到端验收：Task 9。

类型一致性：

- JS 与 C 都使用相同 UUID、frame type、状态码和错误码。
- `taskId` 全程为 unsigned 16-bit。
- `totalBytes` 和 `receivedBytes` 全程为 unsigned 32-bit。
- `totalChunks` 和 `chunkIndex` 全程为 unsigned 16-bit。

执行风险：

- 当前 shell 没有检测到 `idf.py`，实现前必须激活 ESP-IDF 6.x 环境。
- TinyUSB HID descriptor 在 ESP-IDF 6.x 的默认配置是否满足键盘报告，需要在 Task 6 构建时确认；如果构建提示缺少 descriptor，应按 ESP-IDF TinyUSB HID 示例补充 keyboard report descriptor，并保持 `REPORT_ID_KEYBOARD = 1`。
- Windows HexNumpad 对 `A-F` 普通字母键的行为必须在 Task 9 实机验证中确认；如果目标 Windows 不接受普通字母键，应在同一任务中调整 HID keycode 映射并重新验证。
