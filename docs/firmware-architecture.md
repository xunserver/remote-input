# Firmware Architecture

固件按三层主链路组织：

```text
Receiver -> Engine -> Writer
```

`remote_input_core` 定义这条链路的抽象契约和纯业务逻辑。`remote_input_device` 只实现当前 ESP32-S3 设备上的具体通道和外设接线。

## Core

`firmware/components/remote_input_core/` 包含：

- `remote_input_protocol`：协议常量和二进制帧解析。
- `remote_input_task`：分片任务缓冲、重复分片检查、完整性检查。
- `remote_input_engine`：处理 `START`、`DATA`、`COMMIT`，维护接收状态，并在任务完整后提交给 writer。
- `remote_input_status`：状态与错误码，以及 14 字节 status frame 编码。
- `remote_input_utf8`：UTF-8 解码与合法性检查。
- `remote_input_receiver.h`：接收器抽象接口。
- `remote_input_writer.h`：写入器抽象接口。

`core` 不应该依赖 BLE、Wi-Fi、TCP、TinyUSB、LED、LCD 或具体板级资源。它只处理协议、状态机和可替换接口。

## Receiver

Receiver 负责把外部输入通道转换成 `core` 能理解的事件：

```text
connect
control frame
data frame
receiver error
disconnect
```

当前实现是 BLE GATT：

```text
remote_input_ble_receiver
```

后续增加 TCP/Wi-Fi 时，应新增一个 receiver 实现同一个 `remote_input_receiver_t` 接口。TCP/Wi-Fi 层可以有自己的连接、鉴权、会话和 framing，但提交给 engine 的内容应继续是 `remote_input_control_frame_t` 和 `remote_input_data_frame_t`。

## Engine

Engine 是 processor：

```text
remote_input_engine_t
```

它负责：

- 处理 `START`、`DATA`、`COMMIT`。
- 校验任务大小、分片数量、重复分片和缺失分片。
- 在输出端忙时拒绝新任务。
- 在任务完整后把 UTF-8 字节交给 writer runner。
- 通过 status callback 发布状态变化。

Engine 不知道输入来自 BLE 还是 TCP，也不知道输出最终是 USB HID、Mac agent 还是其他机制。

## Writer

Writer 负责把一段完整 UTF-8 字节写入目标环境：

```text
remote_input_writer_t
```

当前实现是 USB HID：

```text
remote_input_hid_writer
```

后续增加 Mac、agent 或其他写入环境时，应新增 writer 实现同一个接口。writer 可以自行决定如何把 UTF-8 转成目标输入动作，但需要返回统一的 `remote_input_error_t`。

`remote_input_writer_runner` 是 device 层的 FreeRTOS 异步执行器。它负责排队、busy 状态、typing/done/error 状态回调，不属于 core。

## Device

`firmware/components/remote_input_device/` 包含具体设备实现：

- `remote_input_ble`：BLE receiver。
- `remote_input_hid`：USB HID writer。
- `remote_input_writer_runner`：异步执行 writer。
- `remote_input_led`：状态 LED。
- `remote_input_display`：可选 LCD 状态显示。
- `remote_input_service`：composition root，负责初始化并把 receiver、engine、writer 和状态输出接起来。

`remote_input_service` 应保持薄层职责。它不应直接处理分片组包、UTF-8 解码或 HID report 细节。

## Extension Rules

新增接收方式：

1. 实现 `remote_input_receiver_t`。
2. 在接收层完成传输特有的连接、鉴权和字节读取。
3. 复用 `remote_input_parse_control_frame()` 和 `remote_input_parse_data_frame()`。
4. 通过 callbacks 把 frame 交给 engine。

新增写入方式：

1. 实现 `remote_input_writer_t`。
2. 在 writer 内处理目标环境特有的输入动作。
3. 返回统一的 `remote_input_error_t`。
4. 在 `remote_input_service` 中替换传给 writer runner 的 writer。

这条边界可以让 BLE/TCP 和 USB HID/Mac agent 独立演进，而不会把传输细节、处理状态机和写入机制混在同一个模块里。
