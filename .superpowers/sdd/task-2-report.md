# Task 2 Report: Firmware CONFIG Frame Parsing and Runtime Config Holder

## 实现内容

本任务按 brief 完成了固件侧 CONFIG 帧解析、运行时配置持有器、receiver/engine callback 扩展，以及 BLE/WebSocket 到 service 的路由接入。

已完成项：

- 在 `remote_input_protocol` 中新增：
  - `REMOTE_INPUT_KEY_DELAY_DEFAULT_MS = 20`
  - `REMOTE_INPUT_KEY_DELAY_MIN_MS = 1`
  - `REMOTE_INPUT_KEY_DELAY_MAX_MS = 200`
  - `REMOTE_INPUT_CONTROL_CONFIG = 3`
  - `remote_input_config_frame_t`
  - `remote_input_parse_config_frame()`
- 在 `remote_input_receiver` 中新增 `remote_input_receiver_config_cb_t` 和 `on_config` 回调。
- 在 `remote_input_engine` 中新增：
  - `remote_input_engine_config_cb_t`
  - `apply_config` callback
  - `remote_input_engine_handle_config()`
- 新增 `remote_input_config` 运行时配置模块：
  - `remote_input_config_init()`
  - `remote_input_config_default()`
  - `remote_input_config_get()`
  - `remote_input_config_update()`
  - 通过 `portMUX_TYPE` 保护共享配置状态
- 在 BLE control characteristic 写入路径中单独识别并解析 `CONFIG` 控制帧，解析成功后通过 `on_config` 分发。
- 在 WebSocket binary frame 处理中单独识别并解析 `CONFIG` 控制帧，解析成功后通过 `on_config` 分发。
- 在 `remote_input_service` 中：
  - 初始化 runtime config holder
  - 将 receiver `on_config` 路由到 `remote_input_engine_handle_config()`
  - 将 engine `apply_config` 路由到 `remote_input_config_update()`

未实现项：

- 未实现 writer/HID delay snapshot。该项属于 Task 3，按 brief 保持未做。

## 测试命令和结果

执行命令：

```sh
eim run "idf.py -C firmware -B firmware/build build"
```

结果：

- PASS
- 成功生成 `firmware/build/remote_input.bin`
- 构建过程中未出现本次改动相关编译或链接错误

## 变更文件

- `firmware/components/remote_input_core/include/remote_input_protocol.h`
- `firmware/components/remote_input_core/remote_input_protocol.c`
- `firmware/components/remote_input_core/include/remote_input_receiver.h`
- `firmware/components/remote_input_core/include/remote_input_engine.h`
- `firmware/components/remote_input_core/remote_input_engine.c`
- `firmware/components/remote_input_device/include/remote_input_config.h`
- `firmware/components/remote_input_device/remote_input_config.c`
- `firmware/components/remote_input_device/CMakeLists.txt`
- `firmware/components/remote_input_device/remote_input_ble.c`
- `firmware/components/remote_input_device/remote_input_ws.c`
- `firmware/components/remote_input_device/remote_input_service.c`

## 自检结果

- 已对照 brief 检查所有指定接口与常量，名称和值与 brief 一致。
- 已确认 CONFIG 帧在 BLE 和 WebSocket 两条 receiver 路径中都单独解析并分发。
- 已确认 `remote_input_service` 初始化时会重置 runtime config 到默认值。
- 已确认配置更新仅修改 runtime config holder，不触碰 writer/HID 逻辑。
- 已确认本次提交未包含 `firmware/build` 产物。
- 已确认未纳入工作树中无关的 `sdk/package-lock.json`。
- 未发现 `firmware/dependencies.lock` 变化，因此未提交该文件。

## 疑虑

- 当前任务只完成 CONFIG 帧解析与配置存储，`key_delay_ms` 尚未在 HID writer 执行路径中生效；这是按任务边界预期留给 Task 3 的。
- 本仓库未在 brief 中要求新增固件单元测试，当前验证主要依赖集成构建通过，未进行硬件侧 BLE/WS 实机输入验证。
