# 仓库协作指南

## 项目结构与模块分布

本仓库包含两个主要交付物：

- `firmware/`：ESP32-S3 的 ESP-IDF 固件项目，用于实现 BLE 到 USB HID 的桥接。
- `sdk/`：浏览器端 TypeScript SDK 与演示页面。

固件组件代码位于 `firmware/components/remote_input_core/` 和 `firmware/components/remote_input_device/`，每个组件的公开头文件放在对应的 `include/` 目录中。`firmware/main/` 是固件入口。

SDK 源码在 `sdk/src/`，演示页面是 `sdk/index.html`，测试文件在 `sdk/tests/`，构建后的 IIFE 包输出到 `sdk/dist/`。协议说明和设计文档放在 `docs/`。

## 构建、测试与开发命令

- `npm --prefix sdk install`：安装 SDK 依赖。
- `npm --prefix sdk run dev`：启动 Vite 演示服务器。
- `npm --prefix sdk run build:sdk`：构建 `sdk/dist/remote-input-sdk.js`。
- `npm --prefix sdk run test:sdk`：先构建 SDK，再运行 Node 协议测试和 SDK 流程测试。
- `eim list`：查看当前系统已安装并选中的 ESP-IDF 版本。
- `eim select v6.0.2`：选择本项目当前验证过的 ESP-IDF 6.0.2。
- `eim run "idf.py -C firmware set-target esp32s3"`：当 `sdkconfig` 缺失或可能过期时，配置固件目标芯片。
- `eim run "idf.py -C firmware -B firmware/build build"`：使用 eim 注入的 ESP-IDF 环境编译固件，并把检查构建产物放在已忽略的目录中。
- `idf.py -C firmware build`：仅在当前 shell 已经激活 ESP-IDF 环境时使用；如果 `firmware/build` 中残留了旧项目路径，先运行 `idf.py -C firmware fullclean`。

当前 agent 环境只负责构建和静态/自动化测试验证，不负责烧录设备、串口监视或实机输入验证。不要在本环境中运行 `idf.py flash`、`idf.py monitor` 或包含 `flash`/`monitor` 的组合命令；需要硬件验证时，在结果中明确说明未执行，并交由具备硬件访问权限的环境完成。

## 代码风格与命名约定

TypeScript 使用 ES modules、命名导出、两个空格缩进；函数和变量使用 `camelCase`。协议常量应放在 `sdk/src/constants.ts` 或固件头文件中。

C 代码使用四个空格缩进；导出的符号使用 `remote_input_` 前缀；函数、结构体和文件名使用 `snake_case`。头文件保持精简，私有辅助函数放在 `.c` 文件中并声明为 `static`。

## 测试要求

SDK 测试使用 Node 内置的 `assert` 模块，测试文件位于 `sdk/tests/*.test.js`。修改帧格式、Web Bluetooth 行为、状态解析或错误处理时，需要同步更新相关测试。提交 SDK 变更前运行 `npm --prefix sdk run test:sdk`。

固件变更至少运行 `eim run "idf.py -C firmware -B firmware/build build"`。如果改动影响 BLE 配对、LED 状态或 HID 输入行为，当前 agent 仍只执行构建验证，并在交付说明中列出尚需人工或硬件环境验证的配对、灯效和实际输入检查。

## 提交与 Pull Request 规范

近期提交使用简短的 conventional-style 标题，例如 `feat: add rgb status led driver`、`fix: avoid initial led state race`、`docs: design rgb status led`。优先使用 `feat:`、`fix:`、`docs:` 等前缀，并用祈使句概括变更。

Pull Request 应说明行为变化，列出已执行的验证命令；如硬件检查未在当前环境执行，需要明确标注未验证项并关联相关 issue 或设计文档。只有演示 UI 发生变化时才需要附截图。

## 安全与配置提示

Web Bluetooth 需要在 Chrome 或 Edge 的安全上下文中运行，通常是 HTTPS 或 `localhost`。当前第一版固件不提供 BLE 认证，不建议在不可信环境中使用。

不要提交本地 ESP-IDF 构建产物、设备专属密钥或生成的依赖缓存。

## ESP-IDF 环境说明

该工作区当前通过 eim 使用 ESP-IDF 6.0.2 验证，安装路径通常由 eim 管理在用户目录下，例如 `/home/xun/.espressif/v6.0.2/esp-idf`。

在本机 Linux 环境中优先使用 `eim run "idf.py ..."`，不要求把 `idf.py` 常驻加入 `PATH`。`eim run` 会为子命令临时设置 `IDF_PATH`、`IDF_TOOLS_PATH`、Python 虚拟环境和工具链路径。

一次干净的验证构建可使用 `eim run "idf.py -C firmware -B firmware/build build"`，成功后会生成 `firmware/build/remote_input.bin`。依赖求解期间，ESP-IDF 可能会更新 `firmware/dependencies.lock`，使其中的 `idf` 版本与当前 eim 选中的 ESP-IDF 版本一致。
