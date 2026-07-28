# V2 Web Bluetooth + ESP32-S3 + USB HID

## 目标与链路

V2 使用两段独立链路，ESP32-S3 是无业务状态的单向上行 relay：

```text
Web Client / SDK Session
  -> WebBluetoothTransport
  -> BLE GATT write
  -> ESP32-S3 relay
  -> USB standard keyboard HID input report
  -> PC Agent
  -> clipboard + system paste
```

网页到 ESP32-S3 是 BLE transport；ESP32-S3 到 PC agent 是 USB HID transport。ESP32-S3
不解析 Session JSON。USB 端只枚举一个标准 Keyboard collection，数据使用标准
Keyboard/Keypad usage 中的 F13-F19 组合承载，不包含 vendor-defined interface。
UTF-8 在进入键码层前按字节分片，因此不依赖键盘布局或输入法。

## BLE GATT

- Device name: `Remote Copy ESP32-S3`
- Service: `7c6b0001-6d5a-4f4f-9d2d-5f6f74656368`
- Browser -> device write: `7c6b0002-6d5a-4f4f-9d2d-5f6f74656368`
- Device -> browser notify: `7c6b0003-6d5a-4f4f-9d2d-5f6f74656368`

网页只能从 HTTPS 或 localhost 的安全上下文调用 Web Bluetooth，且首次设备选择必须由
用户点击触发。当前实现使用 write-with-response，它只确认 ESP 收到 GATT write；
单向上行不提供 agent 处理完成回执，SDK 调用方必须将请求视为无确认发送。
连接前页面会分别诊断非安全上下文和浏览器不支持两种情况，不会打开一个必然失败的设备
选择流程。

## Relay frame V2

所有多字节整数均为 little-endian。BLE 和 HID 使用同一 frame，不在 ESP 内重新分片。

| Offset | Bytes | Field |
| --- | ---: | --- |
| 0 | 2 | Magic `0x5243` |
| 2 | 1 | Version `2` |
| 3 | 1 | Flags，当前为 `0` |
| 4 | 4 | connection-local transfer ID |
| 8 | 2 | zero-based chunk index |
| 10 | 2 | chunk count |
| 12 | 2 | payload length |
| 14 | 2 | payload CRC16-CCITT |
| 16 | 0..48 | payload |

每个 relay-frame 字节拆成高、低两个半字节。每个半字节使用一个标准 8 字节键盘 input
report：F13 是协议标记，F14/F15 表示高/低相位，F16-F19 的按下组合表示四个数据位。
每帧末尾发送全零释放报告。PC agent 只在相位顺序、frame magic、版本、长度、chunk
字段和 CRC 全部通过时才交付 UTF-8；异常或不完整帧整帧丢弃。没有 HID LED 下行通道。

## PC Agent

默认 VID/PID 是 `303a:4002`，可用 `REMOTE_COPY_VID` 和 `REMOTE_COPY_PID` 覆盖。

```bash
pnpm --filter @remote-copy/pc-agent build
INPUT_MODE=dev pnpm --filter @remote-copy/pc-agent start
pnpm --filter @remote-copy/pc-agent start
```

`INPUT_MODE=dev` 只打印重组后的文本。默认模式写入系统剪贴板并模拟粘贴。Linux 需要
`xdotool`（X11）或 `wtype`（Wayland），并可能需要为 HID 设备配置 udev 权限。
macOS 会保护标准键盘的原始 HID 访问，需要在“隐私与安全性 -> 输入监控”中允许实际
运行 PC agent 的终端或 Node 程序。PC Agent 必须以 node-hid 的 `nonExclusive` 模式打开
键盘，让系统继续持有设备；默认的独占模式即使已授权也会被 macOS 拒绝。模拟粘贴还需要
“辅助功能”权限。

开发工作区可以把 PC agent 安装为当前用户的登录启动项，不需要以 root 身份运行：

```bash
pnpm --filter @remote-copy/pc-agent install:user
pnpm --filter @remote-copy/pc-agent uninstall:user
```

- Linux 使用 `systemd --user`。首次安装需将
  `apps/pc-agent/assets/99-remote-copy.rules` 复制到 `/etc/udev/rules.d/`，执行
  `sudo udevadm control --reload-rules && sudo udevadm trigger` 后重新插拔设备。
  使用 `systemctl --user status remote-copy-agent` 和
  `journalctl --user -u remote-copy-agent -f` 查看运行状态与日志。
- macOS 使用 `~/Library/LaunchAgents/com.remote-copy.agent.plist`；首次粘贴时需要在
  “隐私与安全性 -> 辅助功能”中允许实际运行 PC agent 的 Node 程序。
  日志位于 `~/Library/Logs/RemoteCopy/`。
- Windows 使用当前用户的 `Run` 启动项和隐藏 PowerShell launcher；卸载命令会删除启动项
  并终止已安装 launcher 对应的 PC agent 进程。

这些安装项引用当前工作区的 `dist/main.js` 和 Node 可执行文件，移动或删除工作区前应先
运行 `uninstall:user`。PC agent 在设备未插入时保持等待，USB 拔插后会自动重新发现 HID。

### 统一 PC Agent

正常接收方式是运行统一 PC Agent。它通过 `node-hid` 接收 ESP32-S3，同时启动 HTTP 和
WebSocket 服务；HID 与 WebSocket 消息共享同一个串行剪贴板/粘贴队列。访问
`http://localhost:17888/receive/` 可以查看最近 100 条内存消息、来源和处理状态。

浏览器的 WebHID 安全策略通常禁止网页访问键盘 collection，因此标准键盘固件应使用
PC Agent 接收，WebHID 页面不作为此模式的可用备用入口。

## ESP-IDF 6.x

固件位于 `firmware/esp32s3`，要求 ESP-IDF `>=6.0.0 <7.0.0`，并通过 Component
Manager 使用固定版本 `espressif/esp_tinyusb 2.2.1`。
当前固件已使用 ESP-IDF 6.0.2 和 `esp_tinyusb 2.2.1` 完成实际交叉编译验证。

```bash
cd firmware/esp32s3
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/ttyACM0 flash monitor
```

ESP32-S3 原生 USB 使用 GPIO 20 (D+) 和 GPIO 19 (D-)。开发板有两个 USB 口时，应将
电脑连接到标为 `USB`/`OTG` 的原生 USB 口；UART/JTAG 口不能承载自定义 HID。

固件 framing 校验可以在不安装 ESP-IDF 时先用宿主机 C 编译器运行：

```bash
cc -std=c11 -Wall -Wextra -Werror \
  -Ifirmware/esp32s3/main \
  firmware/esp32s3/main/relay_frame.c \
  firmware/esp32s3/tests/relay_frame_test.c \
  -o /tmp/remote-copy-relay-frame-test
/tmp/remote-copy-relay-frame-test

cc -std=c11 -Wall -Wextra -Werror \
  -Ifirmware/esp32s3/main \
  firmware/esp32s3/main/keyboard_uplink.c \
  firmware/esp32s3/tests/keyboard_uplink_test.c \
  -o /tmp/remote-copy-keyboard-uplink-test
/tmp/remote-copy-keyboard-uplink-test
```

实机 BLE 上行可用随固件提供的 Swift 发送器复测：

```bash
swiftc -framework CoreBluetooth -framework Foundation \
  firmware/esp32s3/tests/ble_uplink_sender.swift \
  -o /tmp/remote-copy-ble-uplink-sender
/tmp/remote-copy-ble-uplink-sender '标准键盘 HID 上行测试：中文与 emoji 🙂'
```

macOS IOKit 的 `InputReportCount` 可用于确认 ESP 实际发出了预期数量的 8 字节键盘报告；
完整内容解码仍需给 PC Agent 输入监控权限。

## 当前可靠性边界

- frame 有长度、版本和 CRC 校验，支持 chunk 去重和乱序重组。
- 高/低相位、frame 边界、长度和 CRC 可以检测丢报告、重复报告和位错误；失败时不交付文本。
- BLE write-with-response 只确认 ESP 收到 GATT write，不等于 agent 已处理；当前没有下行确认。
- ESP relay 队列满时 BLE write 返回资源不足；网页请求会失败。
- V2 尚未加入配对认证、应用层加密、跨断线恢复或持久化幂等键。不要发送密码或验证码。
