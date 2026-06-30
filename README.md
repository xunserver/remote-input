# Remote Input

Remote Input 使用 ESP32-S3 作为 BLE 到 USB HID 的输入桥。控制端桌面 Chrome/Edge 通过 Web Bluetooth 发送文本，ESP32-S3 插在目标 Windows 上并模拟 HID 键盘输入 Unicode。

## 仓库结构

- `firmware/`: ESP-IDF 固件工程。
- `sdk/web/`: Web Bluetooth demo；`sdk/src/`: 浏览器端 SDK 源码。
- `sdk/tests/`: SDK 协议测试。
- `docs/windows-enable-hexnumpad.md`: 目标 Windows 的 EnableHexNumpad 配置说明。

## 前置条件

- ESP32-S3。
- ESP-IDF 6.x。
- 控制端桌面 Chrome 或 Edge。
- Web Bluetooth 需要受支持浏览器和安全上下文；优先使用 HTTPS 或 `localhost` 打开 demo。
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
3. 在控制端 Chrome/Edge 打开 `sdk/web/index.html`；如果浏览器拒绝 Web Bluetooth，请通过 HTTPS 或本地 `localhost` 静态服务器访问。
4. 点击连接，选择 `Remote-Input-S3`。
5. 输入文本并点击发送。

## 验证

```powershell
npm --prefix sdk run test:sdk
idf.py -C firmware build
```

当前任务未执行 `idf.py flash` 或实机输入验证；烧录需要已连接硬件并确认端口。

## 限制

- 第一版无 BLE 鉴权，只适合受控环境。
- `typeText()` 最大 16 KB UTF-8。
- ESP32-S3 无法确认目标应用是否实际收到字符。
- 不同 Windows 应用对 HexNumpad 的支持可能不同，第一版以 Notepad 为验收基准。
