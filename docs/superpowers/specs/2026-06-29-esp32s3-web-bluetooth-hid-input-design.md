# ESP32-S3 Web Bluetooth HID 输入设计

## 背景与目标

本项目实现一个受控环境原型：ESP32-S3 通过单个 USB 口插到目标 Windows 电脑后，枚举为 USB HID 键盘；另一台桌面电脑使用 Chrome 或 Edge 通过 Web Bluetooth 连接 ESP32-S3，在浏览器中输入文本并发送给板子；板子再通过 HID 键盘序列把文本输入到目标 Windows 当前焦点应用中。

第一版目标是支持 Unicode 文本输入。目标 Windows 必须提前启用 `EnableHexNumpad=1` 并重新登录。ESP32-S3 不在目标 Windows 上安装任何软件，只模拟 USB HID 键盘，使用 Windows 的 `Alt + 小键盘 + + 十六进制码点` 输入机制。

## 范围

第一版包含：

- ESP-IDF 6.x 固件，目标芯片为 ESP32-S3。
- BLE GATT Server，用于接收浏览器 SDK 发来的文本任务并返回简单状态。
- TinyUSB HID Keyboard，用于向目标 Windows 发送键盘输入。
- 纯浏览器单文件 JavaScript SDK，可直接通过 `<script>` 引入。
- 一个最小 demo 页面，用于连接设备、发送文本、查看简单状态。

第一版不包含：

- 手机浏览器支持。
- TypeScript、npm 包或构建流水线。
- BLE 配对、PIN、实体按钮授权或加密。
- 目标 Windows 本地代理程序。
- 剪贴板写入或粘贴输入方案。
- 完整日志流、持久配置、OTA、设备管理后台。
- 对所有 Windows 应用的输入兼容性保证。

## 前置条件

目标 Windows 电脑需要提前完成一次配置：

1. 在注册表中设置 `HKCU\Control Panel\Input Method\EnableHexNumpad` 为字符串值 `1`。
2. 注销并重新登录，或重启电脑。
3. 打开一个标准文本输入目标，例如 Notepad，作为第一版验收基准。

ESP32-S3 板子只有一个 USB 口时，开发下载、串口日志和 HID 运行会共享同一个物理口。烧录后插到目标 Windows 时，板子应以 HID 键盘形态工作；重新下载固件时需要回到开发机并进入可下载状态。

## 推荐架构

系统由三部分组成：

1. ESP32-S3 固件
   - 同时启用 BLE GATT Server 和 TinyUSB HID Keyboard。
   - 通过 BLE 接收 UTF-8 文本任务，单次最大 16 KB。
   - 解码 UTF-8 为 Unicode scalar value。
   - 对每个码点执行 Windows HexNumpad HID 输入序列。
   - 维护简单任务状态，供浏览器 SDK 查询和等待。

2. 浏览器 JavaScript SDK
   - 使用 Web Bluetooth 连接 ESP32-S3。
   - 提供 `connect()`、`disconnect()`、`typeText(text)`、`getStatus()`。
   - `typeText()` 负责 UTF-8 编码、长度校验、BLE 分包、发送任务、等待完成。

3. Demo 页面
   - 调用 SDK，不直接处理 BLE 细节。
   - 提供连接、输入文本、发送、读取状态的最小 UI。

核心数据流：

```text
控制端 Chrome/Edge
  -> Web Bluetooth GATT Write
  -> ESP32-S3 BLE RX
  -> UTF-8 解码
  -> TinyUSB HID Keyboard
  -> Windows Alt Hex 输入
  -> 目标应用文本框
```

## BLE GATT 协议

固件暴露一个自定义 GATT Service。UUID 在实现时固定为项目私有 UUID，并在 SDK 中内置。

Service 下包含三个 Characteristic：

1. Control Characteristic
   - 浏览器写入控制帧。
   - 第一版只用于开始任务和提交任务。
   - SDK 优先使用 `writeValueWithResponse()`。

2. Data Characteristic
   - 浏览器写入文本分片。
   - 每个分片包含 `taskId`、`chunkIndex`、`totalChunks`、payload。
   - 固件缓存所有分片，全部收齐后才进入输入阶段。

3. Status Characteristic
   - 支持 read 和 notify。
   - 固件通过 notify 返回任务状态变化。
   - SDK 的 `getStatus()` 读取该特征值。
   - SDK 的 `typeText()` 等待同一 `taskId` 的 `done` 或 `error` 状态。

协议帧采用紧凑二进制格式，不使用 JSON。原因是 BLE 包较小，二进制帧能降低开销，并简化固件端确定性解析。SDK 对外仍只暴露字符串和对象接口。

第一版协议限制：

- 同一时间只允许一个 active task。
- 固件处于 `receiving` 或 `typing` 时，新任务返回 busy。
- 文本最大长度按 UTF-8 字节数限制为 16 KB。
- 不做断点续传。
- BLE 断开时，如果处于 `receiving`，丢弃未完成任务。
- BLE 断开时，如果处于 `typing`，固件继续完成当前 HID 输入，避免留下半个 Alt 输入序列。
- 不做 CRC、签名或加密；依赖 BLE 写入响应和长度校验。

## 固件设计

固件按职责拆为五个模块。

### BLE GATT 模块

职责：

- 初始化 BLE Host，优先使用 NimBLE。
- 广播设备名，例如 `AI-Input-XXXX`。
- 注册自定义 Service 和三个 Characteristic。
- 处理连接、断开、读取、写入和 notify。
- 把合法协议帧交给任务缓冲模块。
- 把状态模块的变化推送给已连接浏览器。

### 任务缓冲模块

职责：

- 管理单个 active task。
- 校验 `taskId`、总长度、分片数量、分片序号和 payload 长度。
- 拒绝重复分片、越界分片、长度不匹配和超过 16 KB 的任务。
- 在全部分片收齐后，把完整 UTF-8 缓冲交给输入流程。
- 在 busy 状态下拒绝新任务。

### UTF-8 解码模块

职责：

- 把完整 UTF-8 字节流解码为 Unicode scalar value。
- 支持 BMP 和非 BMP 码点。
- 拒绝非法 UTF-8、过长编码、孤立 surrogate、超过 `U+10FFFF` 的码点。
- 换行、制表符等控制字符第一版也按 Unicode 输入路径处理。
- 如果某些控制字符在 Windows HexNumpad 路径中不可用，固件返回错误，不悄悄替换。

### HID 输入模块

职责：

- 初始化 TinyUSB HID Keyboard。
- 确认 USB HID ready 后才执行输入任务。
- 对每个 Unicode 码点生成大写十六进制字符串，例如 `U+4E2D` 生成 `4E2D`。
- 对每个码点执行输入序列：

```text
Alt down
Numpad +
hex digits
Alt up
```

- 十六进制数字 `0-9` 使用普通数字键输入。
- 十六进制字符 `A-F` 使用普通字母键输入。
- 每个 HID press/release 动作之间使用固定保守延迟，默认 20 ms。
- 第一版不暴露输入速度配置。

### 状态模块

职责：

- 维护当前状态：`idle`、`receiving`、`typing`、`done`、`error`。
- 维护 `lastTaskId`、`lastErrorCode`、`receivedBytes`、`totalBytes`。
- 支持 Status Characteristic read。
- 状态变化时触发 notify。

## SDK 设计

第一版 SDK 是纯浏览器单文件 JavaScript，例如 `web/ai-input-sdk.js`。使用方式：

```html
<script src="./ai-input-sdk.js"></script>
```

对外暴露全局对象 `AIInput`：

```js
const device = await AIInput.connect();
await device.typeText("你好 Windows 👋");
const status = await device.getStatus();
await device.disconnect();
```

### `AIInput.connect(options?)`

职责：

- 检查当前浏览器是否支持 Web Bluetooth。
- 调用 `navigator.bluetooth.requestDevice()`。
- 默认按项目 Service UUID 过滤设备。
- 连接 GATT Server。
- 获取 Control、Data、Status Characteristic。
- 启动 Status notify。
- 返回 `AIInputDevice` 实例。

### `device.typeText(text)`

职责：

- 校验当前已连接。
- 校验没有未完成的 `typeText()`。
- 用 `TextEncoder` 把 JS 字符串编码为 UTF-8。
- 校验 UTF-8 长度不超过 16 KB。
- 创建递增 `taskId`。
- 写入 start control frame。
- 把 UTF-8 字节流分片写入 Data Characteristic。
- 写入 commit control frame。
- 等待 Status notify 返回同一 `taskId` 的 `done` 或 `error`。
- 成功时 resolve，失败时 reject。

### `device.getStatus()`

职责：

- 读取 Status Characteristic。
- 解析二进制状态为 JavaScript 对象：

```js
{
  state: "typing",
  lastTaskId: 12,
  receivedBytes: 1024,
  totalBytes: 4096,
  lastErrorCode: 0
}
```

### `device.disconnect()`

职责：

- 停止 Status notify。
- 断开 GATT 连接。
- 清理 pending promise。
- 如果断开时存在未完成 `typeText()`，该 promise reject。

## 错误处理

SDK 本地错误：

- `WEB_BLUETOOTH_UNSUPPORTED`：浏览器不支持 Web Bluetooth。
- `DEVICE_SELECTION_CANCELLED`：用户取消设备选择。
- `NOT_CONNECTED`：未连接时调用设备方法。
- `TEXT_TOO_LARGE`：UTF-8 字节数超过 16 KB。
- `CLIENT_BUSY`：已有未完成的 `typeText()`。

BLE 传输错误：

- 写入失败。
- GATT 断开。
- notify 等待超时。
- 这些错误会使当前 `typeText()` reject，并清理 SDK pending 状态。

固件接收错误：

- `DEVICE_BUSY`：设备已有 active task。
- `INVALID_COMMAND`：控制帧非法。
- `INVALID_CHUNK`：分片序号、长度或 taskId 非法。
- `DUPLICATE_CHUNK`：重复分片。
- `MISSING_CHUNK`：提交时分片未收齐。
- `TASK_TOO_LARGE`：任务超过 16 KB。

固件输入错误：

- `INVALID_UTF8`：UTF-8 字节流非法。
- `INVALID_CODEPOINT`：码点非法。
- `USB_NOT_READY`：HID 未 ready。
- `HID_INPUT_FAILED`：HID 输入流程失败。

Windows 端兼容问题无法由固件直接检测。如果目标应用没有接收字符，固件仍可能认为任务完成。第一版以 Notepad 和标准文本框作为验收基准。

## 测试设计

### SDK 测试

第一版以 demo 页面手动测试为主，同时保留添加 mock 测试脚本的空间。

需要覆盖：

- Web Bluetooth 不支持时的错误。
- 用户取消选择设备。
- 连接成功后 `getStatus()`。
- UTF-8 长度限制。
- 分包数量计算。
- pending `typeText()` 时再次调用的 busy 错误。
- 固件返回 `done` 时 resolve。
- 固件返回 `error` 时 reject 并携带错误码。
- BLE 断开时 pending promise reject。

### 固件测试

需要覆盖：

- UTF-8 解码：ASCII、中文、emoji、混合文本。
- UTF-8 解码错误：非法 continuation byte、过长编码、孤立 surrogate、超过 `U+10FFFF`。
- BLE 分片缓存：正常顺序、乱序、重复、缺失、越界、超长。
- 状态机：`idle -> receiving -> typing -> done -> idle`，以及错误路径。
- HID 输入序列：通过实机确认 Windows 是否正确接收。

### 端到端实机测试

验收步骤：

1. 目标 Windows 设置 `EnableHexNumpad=1` 并重新登录。
2. ESP32-S3 烧录固件后插入目标 Windows。
3. Windows 识别 ESP32-S3 为 HID 键盘。
4. 目标 Windows 打开 Notepad，并把光标放在文本区。
5. 控制端桌面 Chrome 或 Edge 打开 demo 页面。
6. 通过 Web Bluetooth 连接 ESP32-S3。
7. 发送样例文本：
   - `Hello`
   - `你好`
   - `😀`
   - `Hello 你好 😀`
   - 多行文本
   - 接近 16 KB 的文本
8. 验证 Notepad 中实际输入结果。
9. 验证超长文本、断开连接、设备 busy 等错误路径。

## 关键限制与风险

- Web Bluetooth 主要支持 Chromium 系浏览器；Safari 和 Firefox 不作为第一版目标。
- 控制端仅支持桌面 Chrome 或 Edge。
- 第一版无 BLE 鉴权，附近设备只要能连接就可能触发输入，因此只适合受控环境。
- Alt Hex 输入速度慢，长文本需要等待较久。
- `EnableHexNumpad` 是目标 Windows 的强前置条件，未开启时 Unicode 输入不会按预期工作。
- 不同 Windows 应用、输入控件、远程桌面环境或权限上下文可能对 Alt Hex 输入支持不同。
- ESP32-S3 无法确认目标应用是否真实收到字符，只能确认 HID 序列已发送。
- 单 USB 口板子调试不便，运行 HID 时串口日志可能不可用。

## 第一版完成标准

- ESP32-S3 固件能在目标 Windows 上枚举为 HID 键盘。
- 控制端桌面 Chrome 或 Edge 能通过 Web Bluetooth 连接 ESP32-S3。
- SDK 的 `connect()`、`typeText()`、`getStatus()`、`disconnect()` 可用。
- `typeText()` 对 16 KB 以内文本执行发送并等待完成。
- 在开启 `EnableHexNumpad` 的 Windows Notepad 中，能够输入英文、中文、emoji 和混合文本。
- 主要错误路径有明确错误码和 SDK reject 行为。
