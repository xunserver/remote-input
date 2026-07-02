# Remote Input SDK 与 ESP32 通信协议

本文档描述 Remote Input SDK 与 ESP32-S3 固件之间的通信协议。当前协议版本为 `2`。协议版本 `2` 不兼容 v1。

当前传输层包括 BLE GATT 和 WebSocket。协议帧本身是二进制格式，和传输层耦合较低；后续如果增加其他传输方式，建议继续复用本文定义的帧格式、字节序、状态码和错误码。

## 1. BLE 传输层

ESP32 当前广播名称：

```text
Remote-Input-S3
```

主服务 UUID：

```text
9e7b0001-4f2a-4d3b-9c2a-0d6c9a120001
```

特征值：

| 名称 | UUID | 属性 | 方向 |
| --- | --- | --- | --- |
| Control | `9e7b0002-4f2a-4d3b-9c2a-0d6c9a120001` | Write | SDK -> ESP32 |
| Data | `9e7b0003-4f2a-4d3b-9c2a-0d6c9a120001` | Write, Write Without Response | SDK -> ESP32 |
| Status | `9e7b0004-4f2a-4d3b-9c2a-0d6c9a120001` | Read, Notify | ESP32 -> SDK |

所有多字节整数均使用小端序，也就是低字节在前。

## 2. WebSocket 传输层

固件可同时启用 BLE 和 WebSocket。WebSocket 运行在 ESP32 SoftAP 上：

| 项目 | 值 |
| --- | --- |
| AP SSID | `Remote-Input-S3` |
| AP 密码 | `remoteinput` |
| AP 频道 | `6` |
| 最大客户端数 | `1` |
| URL | `ws://192.168.4.1/ws` |
| 消息类型 | binary |

每条 WebSocket binary message 直接承载一个协议帧：

- START 和 COMMIT 使用 12 字节 Control 帧。
- DATA 使用 8 到 188 字节 Data 帧。
- 设备状态使用 14 字节 Status 帧从固件推送到浏览器。

WebSocket 不增加外层 envelope，不使用 JSON。客户端连接成功后，固件会立即推送当前 Status 帧，之后每次状态变化都会继续推送。

安全边界：当前版本依赖 SoftAP 的 WPA2 密码限制访问，不提供 WebSocket token 或 TLS。任何知道 AP 密码并连接到该热点的客户端都可以向 USB host 注入输入内容。

## 3. 基本限制

| 项目 | 值 |
| --- | --- |
| 协议版本 | `2` |
| 最大文本长度 | `128 * 1024` 字节 |
| 单个 Data 帧 payload 长度 | `180` 字节 |
| Control 帧长度 | `12` 字节，适用于 START、COMMIT 和 CONFIG |
| Data 帧头长度 | `8` 字节 |
| Status 帧长度 | `14` 字节 |

SDK 先把输入文本编码为 UTF-8 字节，再按 180 字节切片发送。ESP32 收完整个任务后会校验 UTF-8，校验通过后才开始通过 USB HID 输入。

## 4. Control 帧

Control 帧固定为 12 字节。在 BLE 传输中，START、COMMIT 和 CONFIG 帧写入 Control 特征值；在 WebSocket 传输中，START、COMMIT 和 CONFIG 帧分别作为独立 binary message 发送。

START/COMMIT 帧格式：

| 偏移 | 长度 | 类型 | 字段 | 说明 |
| --- | ---: | --- | --- | --- |
| 0 | 1 | `uint8` | `version` | 必须为 `2` |
| 1 | 1 | `uint8` | `type` | `1` 表示 START，`2` 表示 COMMIT |
| 2 | 2 | `uint16` | `task_id` | SDK 生成的任务 ID |
| 4 | 4 | `uint32` | `total_bytes` | UTF-8 总字节数 |
| 8 | 2 | `uint16` | `total_chunks` | Data 分片总数 |
| 10 | 2 | `uint16` | `reserved` | 保留字段，必须为 `0` |

Control 帧类型：

| 值 | 名称 | 含义 |
| ---: | --- | --- |
| 1 | START | 开始一个新的文本输入任务 |
| 2 | COMMIT | 表示所有 Data 分片已经发送完，可以提交执行 |
| 3 | CONFIG | 更新设备运行时配置 |

START/COMMIT 校验规则：

- `version` 必须为 `2`。
- `type` 只能是 START 或 COMMIT。
- `total_bytes` 不能超过 128 KB。
- `total_chunks` 必须大于 0。
- `reserved` 必须为 0。
- START 帧中，`total_chunks` 必须等于 `ceil(total_bytes / 180)`；空文本例外，空文本使用 1 个 chunk。
- COMMIT 帧中，`task_id`、`total_bytes`、`total_chunks` 必须和当前正在接收的任务一致。

CONFIG 帧格式：

| 偏移 | 长度 | 类型 | 字段 | 说明 |
| --- | ---: | --- | --- | --- |
| 0 | 1 | `uint8` | `version` | 必须为 `2` |
| 1 | 1 | `uint8` | `type` | 必须为 `3` |
| 2 | 2 | `uint16` | `flags` | 保留字段，必须为 `0` |
| 4 | 2 | `uint16` | `key_delay_ms` | HID report 之间的延迟，范围 `1..200` 毫秒 |
| 6 | 6 | `bytes` | `reserved` | 保留字段，必须全部为 `0` |

CONFIG 校验规则：

- `version` 必须为 `2`。
- `type` 必须为 CONFIG。
- `flags` 必须为 `0`。
- `key_delay_ms` 必须在 `1..200` 范围内。
- `reserved` 必须全部为 `0`。

CONFIG 只更新运行时配置，不写入 NVS。设备重启后恢复默认 `key_delay_ms = 20`。配置变更只影响后续输入任务；正在输入的任务继续使用任务提交时捕获的配置快照。

## 5. Data 帧

在 BLE 传输中，Data 帧写入 Data 特征值；在 WebSocket 传输中，每个 Data 帧作为独立 binary message 发送。

Data 帧长度为 `8 + payload_len`。其中 `payload_len` 范围是 0 到 180 字节。

| 偏移 | 长度 | 类型 | 字段 | 说明 |
| --- | ---: | --- | --- | --- |
| 0 | 1 | `uint8` | `version` | 必须为 `2` |
| 1 | 1 | `uint8` | `type` | 必须为 `16` |
| 2 | 2 | `uint16` | `task_id` | 当前任务 ID |
| 4 | 2 | `uint16` | `chunk_index` | 从 0 开始的分片序号 |
| 6 | 2 | `uint16` | `total_chunks` | 分片总数 |
| 8 | 0..180 | bytes | `payload` | UTF-8 字节片段 |

Data 帧类型：

| 值 | 名称 |
| ---: | --- |
| 16 | DATA |

校验规则：

- `version` 必须为 `2`。
- `type` 必须为 `16`。
- 帧总长度必须在 8 到 188 字节之间。
- `total_chunks` 必须大于 0。
- 只有空文本任务允许 `payload_len == 0`，并且此时 `total_chunks` 必须为 1。
- `task_id` 和 `total_chunks` 必须和当前任务一致。
- `chunk_index` 必须小于 `total_chunks`。
- 同一个 `chunk_index` 不能重复发送。
- 每个分片的 payload 长度必须符合预期：
  - 中间完整分片固定为 180 字节。
  - 最后一个分片是剩余字节数。
  - 空文本任务的唯一分片为 0 字节。

Data 分片可以乱序到达。ESP32 会按 `chunk_index` 写入缓冲区。但是 COMMIT 只有在所有分片都收到后才会成功。

## 6. Status 帧

Status 帧固定为 14 字节。在 BLE 传输中，SDK 可以主动读取 Status 特征值，也可以订阅 Notify 获取状态变化；在 WebSocket 传输中，固件会在连接建立后推送当前 Status 帧，并在状态变化时继续推送 Status 帧。

| 偏移 | 长度 | 类型 | 字段 | 说明 |
| --- | ---: | --- | --- | --- |
| 0 | 1 | `uint8` | `version` | 固定为 `2` |
| 1 | 1 | `uint8` | `state` | 设备状态 |
| 2 | 2 | `uint16` | `last_task_id` | 相关任务 ID |
| 4 | 2 | `uint16` | `last_error` | 错误码 |
| 6 | 4 | `uint32` | `received_bytes` | 已接收字节数，或当前任务字节数 |
| 10 | 4 | `uint32` | `total_bytes` | 当前任务总字节数 |

状态码：

| 值 | 名称 | 含义 |
| ---: | --- | --- |
| 0 | idle | 空闲，没有正在接收的任务 |
| 1 | receiving | 正在接收 Data 分片 |
| 2 | typing | 正在通过 USB HID 输入 |
| 3 | done | 任务完成 |
| 4 | error | 任务失败 |

错误码：

| 值 | 名称 | 含义 |
| ---: | --- | --- |
| 0 | OK | 无错误 |
| 1 | DEVICE_BUSY | 设备忙，已有接收或输入任务正在进行 |
| 2 | INVALID_COMMAND | Control 帧非法 |
| 3 | INVALID_CHUNK | Data 帧非法 |
| 4 | DUPLICATE_CHUNK | 重复发送了同一个分片 |
| 5 | MISSING_CHUNK | COMMIT 时仍有分片缺失 |
| 6 | TASK_TOO_LARGE | 文本超过 128 KB，或设备当前内存不足以接收任务 |
| 7 | INVALID_UTF8 | 接收到的字节不是合法 UTF-8 |
| 8 | INVALID_CODEPOINT | Unicode 码点无法输入 |
| 9 | USB_NOT_READY | USB HID 尚未就绪 |
| 10 | HID_INPUT_FAILED | HID report 发送失败 |

## 7. 正常发送流程

发送非空文本时，SDK 和 ESP32 的交互流程如下：

SDK 可以在连接后发送 CONFIG 帧更新运行时参数，例如 `key_delay_ms`。如果 SDK 不发送 CONFIG，设备使用默认 `20ms` 输入延迟。

1. SDK 将文本编码为 UTF-8 字节。
2. SDK 检查字节数是否超过 128 KB；超过则本地报错，不发送。
3. SDK 生成 `task_id`。
4. SDK 计算 `total_chunks = ceil(total_bytes / 180)`。
5. SDK 通过当前传输层发送 START 帧。
6. SDK 通过当前传输层发送所有 DATA 帧。
7. SDK 通过当前传输层发送 COMMIT 帧。
8. ESP32 检查分片是否完整。
9. ESP32 校验完整 payload 是否为合法 UTF-8。
10. ESP32 将 UTF-8 解码为 Unicode code point。
11. ESP32 通过 USB HID 逐个输入 code point。
12. ESP32 通过当前传输层返回 DONE 或 ERROR 状态。

发送空文本时：

- `total_bytes` 为 `0`。
- `total_chunks` 为 `1`。
- SDK 仍然发送一个 DATA 帧，但 payload 长度为 0。

## 8. task_id 规则

SDK 当前从 `1` 开始生成 `task_id`，每次任务递增。

当 `task_id` 到达 `65535` 后，下一个任务回绕到 `1`。

ESP32 把 `task_id` 当作 `uint16` 透明值处理，只检查同一个任务中的 START、DATA、COMMIT 是否一致。

## 9. 后续传输扩展

后续如果增加新的传输层，建议保持本文定义的二进制帧不变。

推荐做法：

- START、DATA、COMMIT 仍然作为独立二进制消息发送；或者在外层增加很薄的 transport envelope，但内部 frame bytes 必须保持不变。
- Status 仍然使用同一个 14 字节二进制结构。
- 继续使用小端整数。
- 继续使用相同的任务生命周期、状态码和错误码。
- 鉴权、配对、加密等传输层能力放在协议外层，不要塞进基础帧格式。

协议版本 `2` 已固定使用 180 字节 Data payload，并且不兼容 v1。后续如果需要进一步提升 WebSocket 单包大小或引入流式输入，应通过新的协议版本实现。
