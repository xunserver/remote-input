# 远程输入

这是一个 pnpm workspace + Turborepo 管理的远程输入 monorepo。接收电脑只需运行一个
PC Agent；它同时接收 WebSocket 和 ESP32-S3 USB HID 输入，展示最近消息，并通过同一条
串行队列写入系统剪贴板和模拟粘贴。

## 架构

```text
WebSocket 发送端 ─┐
                  ├─> PC Agent 消息中心 -> 全局输入队列 -> 剪贴板 / 系统粘贴
ESP32-S3 USB HID ─┘             │
        <── inputStatus notify ─┤
                                └─> HTTP API + SSE -> 接收看板
```

- `/`：Vue 发送端，支持 WebSocket 和 Web Bluetooth。
- `/receive/`：PC Agent 接收看板，展示 WS/HID 来源、时间和处理状态。
- `/webhid/`：目标电脑不能运行 PC Agent 时使用的 WebHID 备用接收页。
- `/ws`：V1 Session WebSocket 协议入口。
- `/events`：接收看板的 SSE 快照和实时事件。

PC Agent 只在内存保存最近 100 条消息，重启后清空。发送端收到成功响应时，对应输入已经
完成配置的处理，而不只是进入队列。

每次输入都可携带独立控制参数：是否在复制后触发系统粘贴，以及处理后是否恢复接收端
原剪贴板。旧的 `{ text }` 报文继续使用“自动粘贴、不要恢复”的默认值。接收端通过原生
单向 `inputStatus` notify 反馈排队、处理、复制、粘贴、剪贴板恢复和最终结果；WebSocket
直接回传，蓝牙链路通过 USB HID output report 和 BLE notify 反向回传。

## Workspace

```text
apps/
  client/          WebSocket/Web Bluetooth 发送端
  pc-agent/        唯一 Node 接收进程：HTTP、WS、HID、消息队列和系统输入
  receiver/        PC Agent 接收看板
  web-agent/       独立 WebHID 备用接收页

packages/
  device-protocol/ ESP32-S3 relay frame 编解码与重组
  protocol/        Session、Transport 与 WebSocket/Web Bluetooth 实现
  sdk/             类型化发送客户端
  web-agent-sdk/   HID RelayAgent 与 WebHID agent
```

`apps/pc-agent` 将三个前端声明为 workspace 开发依赖。Turborepo 会先构建它们，再把产物
打包到 `apps/pc-agent/dist/public` 的根目录、`receive` 和 `webhid` 子目录。

## 使用

```bash
pnpm install
pnpm build
pnpm start
```

默认地址为 `http://localhost:17888`，PC Agent 默认监听 `0.0.0.0`。开发时可分别运行：

```bash
INPUT_MODE=dev pnpm dev:pc-agent
pnpm dev:client
pnpm dev:receiver
pnpm dev:web-agent
```

### GitHub Pages Web 应用

仓库内的 `deploy-client-pages.yml` 会在 `main` 分支的相关前端代码变化后构建发送端和
WebHID 接收页，把静态文件发布到专用的 `gh-pages` 分支。Pages 的发布源应设为
`gh-pages` 分支的根目录；日常开发代码只保留在 `main`。

- `https://xunserver.github.io/remote-input/`：WebSocket/Web Bluetooth 发送端。
- `https://xunserver.github.io/remote-input/webhid/`：独立 WebHID 接收页。

Web Bluetooth 只能在安全上下文中使用，选择设备还必须由用户点击触发。GitHub Pages
提供浏览器信任的 HTTPS，WebHID 页面可直接访问浏览器已授权的兼容设备，不依赖目标
电脑运行 PC Agent。普通自签名证书只有在设备已安装并信任对应根证书时才可用，不建议
将“忽略证书警告”作为部署方案。HTTPS 不会补齐浏览器缺失的 Web Bluetooth 或 WebHID
实现；Web Bluetooth 手机端建议使用 Android Chrome，WebHID 使用桌面版 Chrome 或
Edge；Safari/WebKit 当前没有实现这些 API。

仓库和 Pages 站点都是公开的。发送端静态页面不包含服务端凭据，但浏览器本地保存的
输入历史不会随页面一起发布。

PC Agent 配置：

- `HOST`：监听地址，默认 `0.0.0.0`。
- `PORT`：HTTP/WS 端口，默认 `17888`。
- `INPUT_MODE=paste|dev`：默认 `paste`；`dev` 仅打印收到的文字。
- `REMOTE_INPUT_VID` / `REMOTE_INPUT_PID`：HID VID/PID，默认 `303a:4002`。
- `PROTOCOL_DEBUG=summary|chunks`：服务端协议追踪。

安装为当前用户的登录启动项：

```bash
pnpm install:user
pnpm uninstall:user
```

Linux 需要 `xdotool`（X11）或 `wtype`（Wayland），并可能需要安装
`apps/pc-agent/assets/99-remote-input.rules`。macOS 首次粘贴时需要为实际运行 Agent 的
Node 程序授予辅助功能权限。

## 验证

```bash
pnpm check
pnpm test
pnpm build
```

V2 Web Bluetooth、ESP32-S3 relay frame、固件构建和 USB 权限细节见
[V2 架构](docs/v2-ble-hid-architecture.md)。V1 Session 和 WebSocket 协议见
[SDK Request/Response 协议](docs/sdk-protocol-v1.md)。

## 安全边界

当前版本没有认证、授权或 WebSocket Origin 校验，并默认监听所有网卡。任何能连接
`/ws` 的设备都可以请求本机执行粘贴；请只在可信网络使用，或通过 `HOST=127.0.0.1`、
防火墙和反向代理限制访问。

消息正文会以明文保存在 PC Agent 内存和发送端浏览器历史中，并显示在 `/receive/`。
不要发送密码、一次性验证码等敏感内容；`INPUT_MODE=dev` 还会把正文输出到终端。
