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
- `/bookmarklet/`：书签 loader 在 iframe 或独立窗口中打开的快速发送页。
- `/receive/`：PC Agent 接收看板，展示 WS/HID 来源、时间和处理状态。
- `/webhid/`：目标电脑不能运行 PC Agent 时使用的 WebHID 备用接收页。
- `/ws`：V1 Session WebSocket 协议入口。
- `/events`：接收看板的 SSE 快照和实时事件。

发送端页面底部提供“快速发送选中文本”书签脚本。将按钮拖到浏览器书签栏后，在任意
网页选中文字并点击书签，会按需加载远端脚本并注入一个隔离的悬浮发送窗。悬浮窗复用
发送端域名下保存的 WebSocket 配置，首次使用前需先在完整发送页连接一次。

PC Agent 只在内存保存最近 100 条消息，重启后清空。发送端收到成功响应时，对应输入已经
完成配置的处理，而不只是进入队列。

每次输入都可携带独立控制参数：是否在复制后触发系统粘贴，以及处理后是否恢复接收端
原剪贴板。旧的 `{ text }` 报文继续使用“自动粘贴、不要恢复”的默认值。接收端通过原生
单向 `inputStatus` notify 反馈排队、处理、复制、粘贴、剪贴板恢复和最终结果；WebSocket
直接回传，蓝牙链路通过 USB HID output report 和 BLE notify 反向回传。

## Workspace

```text
apps/
  client/          Vite 多页面：发送端、书签快速页、接收看板和 WebHID 备用接收页
  pc-agent/        唯一 Node 接收进程：HTTP、WS、HID、消息队列和系统输入

packages/
  device-protocol/ ESP32-S3 relay frame 编解码与重组
  protocol/        Session、Transport 与 WebSocket/Web Bluetooth 实现
  sdk/             类型化发送客户端
  web-agent-sdk/   HID RelayAgent 与 WebHID agent
```

`apps/client` 通过 Vite multi-page build 一次生成根目录、`bookmarklet`、`receive`
和 `webhid` 四个页面，再通过 library mode 将 TypeScript loader 构建为根目录的
`bookmarklet.js`。`apps/pc-agent` 将 `client` 声明为 workspace 开发依赖；
Turborepo 会先构建它，再把完整产物打包到 `apps/pc-agent/dist/public`。其中
`receive` 只属于 PC Agent 分发，不发布到公开 Pages 站点。

`pnpm build` 生成 PC Agent 使用的完整 `dist`；`pnpm build:pages` 使用同一份 Vite
配置生成不含 `receive` 入口及其专属资源的 `dist-pages`。

## 使用

```bash
pnpm install
pnpm build
pnpm start
```

### 免安装 Node.js 的 PC Agent 发行包

在目标操作系统和 CPU 架构的构建机上运行：

```bash
pnpm package:pc-agent
```

产物位于 `apps/pc-agent/release/remote-input-<platform>-<arch>/`，包含生产应用、原生依赖和
经过 SHA-256 校验的官方 Node.js Runtime。接收端用户不需要安装 Node.js 或 pnpm，保持
产物目录结构不变并运行 `start.cmd`（Windows）、`start.command`（macOS）或 `start.sh`
（Linux）即可。登录启动项也应通过产物目录中的安装/卸载脚本配置。

发行包默认内置构建机当前使用的 Node.js 版本；可以通过
`REMOTE_INPUT_NODE_VERSION=24.x.x pnpm package:pc-agent` 固定其他完整版本号。由于
`node-hid` 是原生模块，每个发行包必须在对应的平台和架构上构建，不应把一个平台的
`node_modules` 与另一个平台的 Runtime 混合。Node.js 仅在构建机上需要。

网络较慢时可设置 `REMOTE_INPUT_NODE_MIRROR` 更换 Runtime 二进制下载源；校验清单始终
从 `nodejs.org` 获取，镜像文件仍必须通过 Node.js 官方 SHA-256 校验才会进入发行包。

`.github/workflows/build-pc-agent.yml` 会在 `main` 的相关改动、`v*` 标签或手动触发时，
分别使用原生 GitHub runner 构建 Linux x64、Windows x64、macOS ARM64 和 macOS Intel
x64 压缩包，并作为 Actions artifacts 保留 14 天。打包阶段会使用内置 Runtime 实际加载
一次 `node-hid`，原生模块与目标平台不匹配时任务会失败，不会上传不可运行的产物。

默认地址为 `http://localhost:17888`，PC Agent 默认监听 `0.0.0.0`。开发时可分别运行：

```bash
INPUT_MODE=dev pnpm dev:pc-agent
pnpm dev:client
```

`pnpm dev:client` 同时提供 `/`、`/bookmarklet/`、`/receive/` 和 `/webhid/`。

### GitHub Pages Web 应用

仓库内的 `deploy-client-pages.yml` 会在 `main` 分支的相关前端代码变化后构建发送端和
WebHID 接收页，把静态文件发布到专用的 `gh-pages` 分支。Pages 的发布源应设为
`gh-pages` 分支的根目录；日常开发代码只保留在 `main`。

- `https://blog.xunserver.cn/remote-input/`：WebSocket/Web Bluetooth 发送端。
- `https://blog.xunserver.cn/remote-input/bookmarklet/`：书签快速发送页。
- `https://blog.xunserver.cn/remote-input/bookmarklet.js`：书签按需加载的稳定入口。
- `https://blog.xunserver.cn/remote-input/webhid/`：独立 WebHID 接收页。

### 书签脚本加载与降级

书签栏中只保存轻量 `javascript:` 启动器，不内嵌 Vue、SDK 或协议代码。每次点击时：

1. 启动器从当前网页读取普通文本选区，或 `input` / `textarea` 的选区。
2. 启动器用时间戳绕过缓存，下载 Pages 上稳定地址的 `bookmarklet.js`。
3. loader 使用 Shadow DOM 创建悬浮层，并在 iframe 中加载完整发送端；iframe 入口
   HTML 复用 loader 的时间戳绕过缓存，Vite 的哈希 JS/CSS 资源仍可长期缓存。
4. 快速发送窗读取已保存的连接配置：WebSocket 自动重连；首次使用或选择蓝牙时展示
   完整的“蓝牙 / WebSocket”连接步骤。蓝牙设备首次选择仍由用户点击触发；授权成功后
   的新快速窗会优先复用浏览器已授权设备自动重连。
5. 选中文字只通过限定目标 origin 的 `postMessage` 传入 iframe，不写入请求 URL。
6. loader 在当前网页内保留一个持久控制器。关闭悬浮层只隐藏 iframe，不销毁连接；
   iframe 已连接时再次点击书签会重新显示并直接发送。

兼容与降级顺序：

- loader 已存在时直接复用，不重复下载或注册事件；重复点击只更新选中文字。
- loader 为发送 iframe 声明 `bluetooth` 权限；如果目标网页通过 Permissions Policy
  禁止蓝牙，用户仍可使用 WebSocket，或在完整发送页中连接蓝牙。
- iframe 被页面 `frame-src`、网络或其他策略阻止时，5 秒后显示“独立发送页”按钮。
  独立页使用固定窗口名称，loader 会持续保存其引用：再次点击书签时，独立页仍打开则
  聚焦并发送，已经关闭则直接重新打开，不再重新等待 iframe 超时。
- loader 自身被严格 `script-src` CSP 阻止时，启动器直接尝试打开独立小窗，并把文字
  放在 URL fragment 中作为最后降级。fragment 不会随 HTTP 请求发送，发送页读取后会
  立即从地址栏和历史项中清除。失败的 loader script 会被删除，启动器会保留最小
  fallback 控制器，因此关闭独立页后仍可再次点击书签重开。
- 弹窗也被阻止时显示明确提示，用户可允许当前网站打开弹窗或直接访问完整发送页。
- 普通 iframe 模式点击遮罩空白会隐藏悬浮层；兼容提示状态点击空白不会销毁或隐藏
  控制器。发送成功不会自动关闭 iframe 或独立发送页。

Pages 构建通过 Vite library mode 将
`apps/client/src/bookmarklet/loader.ts` 发布为稳定地址的 `bookmarklet.js`；三个页面
的应用资源继续由 Vite 生成内容哈希文件名。因此 loader 的兼容修复会自动应用到已安装
书签，同时大型资源仍能命中浏览器缓存。若目标网页连 loader 本身都被 CSP 阻止，远端
修复无法在该页面执行；这类站点需要重新安装包含新版 fallback 启动器的书签。

在 HTTPS 网页中使用时，Pages、loader 和 iframe 都是 HTTPS，不会形成混合内容。
WebSocket 接收端也必须提供 `wss://`；浏览器不会允许 HTTPS 发送页连接明文 `ws://`。

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
pnpm --filter @remote-input/e2e exec playwright install chromium
pnpm test:e2e
pnpm build
```

`pnpm test:e2e` 会构建前端和 PC Agent，以 `INPUT_MODE=dev` 在本机拉起测试服务，
再用 Chromium 完成 WebSocket 连接、发送、接收看板、历史和重连等浏览器端到端验证。
本地运行默认打开可见浏览器并适度放慢操作，CI 环境则自动使用无界面模式。
首次运行前需要安装一次 Playwright Chromium；测试失败时可在
`apps/e2e/playwright-report` 和 `apps/e2e/test-results` 查看报告、截图、录像与 trace。

在 VS Code 中需要逐步观察、筛选或重复运行用例时，可以运行：

```bash
pnpm test:e2e:ui
```

也可以安装工作区推荐的 Microsoft Playwright Test for VSCode 扩展，在 Testing
侧边栏运行或调试单条用例；调试模式会停在断点并保留可见浏览器。

当前 18 条浏览器用例覆盖：

- 页面加载、控制台异常、首次连接、错误端点恢复、主动断开、服务异常退出、重连和重置；
- 空白输入、Enter 发送、多行输入、桌面/移动端发送控制及发送中防重复提交；
- Unicode、HTML-like 文本、长消息的无损发送，以及 WebSocket 来源和完成状态；
- SSE 实时更新与初始快照、双发送端数量、发送历史持久化、重发和两侧独立清空。

V2 Web Bluetooth、ESP32-S3 relay frame、固件构建和 USB 权限细节见
[V2 架构](docs/v2-ble-hid-architecture.md)。V1 Session 和 WebSocket 协议见
[SDK Request/Response 协议](docs/sdk-protocol-v1.md)。

## 安全边界

当前版本没有认证、授权或 WebSocket Origin 校验，并默认监听所有网卡。任何能连接
`/ws` 的设备都可以请求本机执行粘贴；请只在可信网络使用，或通过 `HOST=127.0.0.1`、
防火墙和反向代理限制访问。

消息正文会以明文保存在 PC Agent 内存和发送端浏览器历史中，并显示在 `/receive/`。
不要发送密码、一次性验证码等敏感内容；`INPUT_MODE=dev` 还会把正文输出到终端。
