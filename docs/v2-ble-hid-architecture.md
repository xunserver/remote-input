# V2 Web Bluetooth + ESP32-S3 + USB HID

## 目标与链路

V2 使用两段独立链路，ESP32-S3 是无业务状态的双向 relay：

```text
Web Client / SDK Session
  -> WebBluetoothTransport
  -> BLE GATT write
  -> ESP32-S3 relay
  -> USB vendor-defined HID input report
  -> PC Agent
  -> clipboard + system paste
  -> Session response over HID output report
  -> ESP32-S3 BLE notification
  -> Web Client / SDK Session
```

网页到 ESP32-S3 是 BLE transport；ESP32-S3 到 PC agent 是 USB HID transport。ESP32-S3
不解析 Session JSON，也不模拟普通键盘字符。使用 vendor-defined HID 是为了可靠传输
UTF-8、中文、emoji 和控制字符，避免受键盘布局、输入法与 Unicode 支持影响。

## BLE GATT

- Device name: `Remote Copy ESP32-S3`
- Service: `7c6b0001-6d5a-4f4f-9d2d-5f6f74656368`
- Browser -> device write: `7c6b0002-6d5a-4f4f-9d2d-5f6f74656368`
- Device -> browser notify: `7c6b0003-6d5a-4f4f-9d2d-5f6f74656368`

网页只能从 HTTPS 或 localhost 的安全上下文调用 Web Bluetooth，且首次设备选择必须由
用户点击触发。当前实现使用 write-with-response；业务完成以 agent 返回的 Session
response 为准。
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

USB 使用无 report ID 的 64 字节 vendor HID report。短 frame 在 USB 线上补零到 64 字节，
payload length 确定有效边界。`node-hid` 写 API 要求数组第一个字节为 report ID，因此 PC agent
写出时额外前置 `0`；这个字节不在线上传输。

## PC Agent

默认 VID/PID 是 `303a:4002`，可用 `REMOTE_COPY_VID` 和 `REMOTE_COPY_PID` 覆盖。

```bash
pnpm --filter @remote-copy/pc-agent build
INPUT_MODE=dev pnpm --filter @remote-copy/pc-agent start
pnpm --filter @remote-copy/pc-agent start
```

`INPUT_MODE=dev` 只打印重组后的文本。默认模式写入系统剪贴板并模拟粘贴。Linux 需要
`xdotool`（X11）或 `wtype`（Wayland），并可能需要为 HID 设备配置 udev 权限。

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

### WebHID agent

目标电脑不能运行桌面 agent 时，可以使用桌面版 Chrome 或 Edge 打开 WebHID 接收页：

```bash
pnpm --filter @remote-copy/web-agent dev
```

开发地址为 `http://localhost:5174`。执行完整服务端构建后也可从
`http://localhost:17888/receive/` 打开。部署到其他主机时必须使用 HTTPS；WebHID 只在
安全上下文可用。首次选择设备必须由用户点击“连接设备”触发，浏览器授权过的设备会在
再次打开页面时自动恢复连接。

页面只负责展示、复制和清空。`@remote-copy/web-agent-sdk` 的 `WebHidAgent` 负责设备筛选、
HID report 监听、Relay frame 重组、UTF-8/Session 请求解析、串行调用 `onText`，并在处理
完成后通过 HID output report 回写 Session response：

```ts
import { WebHidAgent } from "@remote-copy/web-agent-sdk";

const agent = new WebHidAgent({
  onText(text) {
    console.log(text);
  },
});

await agent.connect(); // 必须从用户点击事件调用
```

`connectAuthorized()` 可恢复已授权设备而不弹出选择框，`disconnect()` 主动断开当前设备，
`close()` 同时释放设备和全局 WebHID 监听器。默认只接受固件 VID/PID `303a:4002` 以及
vendor usage page `ff00`、usage `01`。

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
```

## 当前可靠性边界

- frame 有长度、版本和 CRC 校验，支持 chunk 去重和乱序重组。
- SDK request timeout 覆盖 BLE、HID、agent 粘贴及 response 返回全过程。
- BLE write-with-response 只确认 ESP 收到 GATT write，不等于 agent 已处理。
- ESP relay 队列满时 BLE write 返回资源不足；网页请求会失败。
- V2 尚未加入配对认证、应用层加密、跨断线恢复或持久化幂等键。不要发送密码或验证码。
