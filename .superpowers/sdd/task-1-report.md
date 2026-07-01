# Task 1 Report: SDK Protocol and Client Config API

## 实现内容

- 在 `sdk/src/constants.ts` 新增 CONFIG 控制帧常量与运行时按键延迟默认值、上下限：
  - `CONTROL_CONFIG = 3`
  - `DEFAULT_KEY_DELAY_MS = 20`
  - `MIN_KEY_DELAY_MS = 1`
  - `MAX_KEY_DELAY_MS = 200`
- 在 `sdk/src/types.ts` 新增公开类型 `RemoteInputConfig`，结构为 `{ keyDelayMs: number }`。
- 在 `sdk/src/protocol.ts` 新增：
  - `assertConfig(config)`：校验 `keyDelayMs` 必须为 1 到 200 的整数，失败抛出 `INVALID_CONFIG`
  - `encodeConfigFrame(config)`：编码 12 字节 CONFIG 帧
  - `_internals.constants` 补充 CONFIG 相关常量
- 在 `sdk/src/device.ts` 为 `RemoteInputClient` 新增：
  - 配置缓存 `config`
  - `getConfig()`
  - `setConfig(config)`
  - 默认初始配置为 `{ keyDelayMs: 20 }`
  - 写入失败时复用既有 transport kind 生成 `BLE_WRITE_FAILED` / `WS_WRITE_FAILED`
- 在 `sdk/src/transport/ble.ts` 新增 `ConnectBleOptions`，支持 `connectBle({ config })` / `connect({ config })` 连接时写入配置。
- 在 `sdk/src/transport/ws.ts` 扩展 `ConnectWsOptions`，支持 `connectWs(url, { config })` 在收到初始状态后立即写入配置；如果写入失败，会断开 transport 并 reject。
- 在 `sdk/src/index.ts`：
  - 导出 `RemoteInputConfig`
  - 将 `assertConfig`、`encodeConfigFrame` 暴露到 `_internals`，以支持现有 Node 测试模式
- 在 `sdk/tests/sdk-protocol.test.js` 增加协议层与 SDK 流程测试，覆盖：
  - 常量值
  - CONFIG 帧编码
  - config 校验边界
  - `getConfig()` / `setConfig()`
  - 非法配置
  - 未连接写配置
  - WebSocket connect-time config
  - BLE connect-time config
  - BLE config 写失败

## 测试命令和结果

- RED:
  - 命令：`npm --prefix sdk run test:sdk`
  - 结果：失败
  - 关键证据：`sdk/tests/sdk-protocol.test.js:52` 断言 `constants.CONTROL_CONFIG === 3` 失败，实际为 `undefined`
- GREEN:
  - 命令：`npm --prefix sdk run test:sdk`
  - 结果：通过
  - 关键输出：`sdk protocol tests passed`

## TDD RED/GREEN 证据

### RED

- 先按 brief 在 `sdk/tests/sdk-protocol.test.js` 增加 CONFIG 常量、编码、校验以及 client config API 测试。
- 在未实现生产代码前运行：

```sh
npm --prefix sdk run test:sdk
```

- 失败输出关键片段：

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
undefined !== 3
at .../sdk/tests/sdk-protocol.test.js:52:10
```

### GREEN

- 完成最小实现后再次运行：

```sh
npm --prefix sdk run test:sdk
```

- 成功输出关键片段：

```text
✓ built in 111ms
sdk protocol tests passed
```

## 变更文件

- `sdk/src/constants.ts`
- `sdk/src/types.ts`
- `sdk/src/protocol.ts`
- `sdk/src/device.ts`
- `sdk/src/transport/ble.ts`
- `sdk/src/transport/ws.ts`
- `sdk/src/index.ts`
- `sdk/tests/sdk-protocol.test.js`

## 自检结果

- 已核对改动范围，仅修改 brief 指定的 8 个 SDK 文件。
- 已确认 `npm --prefix sdk run test:sdk` 最新一次执行通过。
- 已检查 connect-time config 在 BLE 与 WS 两条路径都带测试覆盖。
- 已确认非法配置不会污染 client 本地 config cache。
- 已确认 transport 未连接时 `setConfig()` 返回 `NOT_CONNECTED`。
- 已保留工作树中无关未跟踪文件 `sdk/package-lock.json`，未纳入改动。

## 疑虑

- `RemoteInputClient.getConfig()` 为兼容当前 IIFE + `vm` 测试环境中的跨 realm `deepEqual`，采用了与 `decodeStatusFrame()` 类似的对象构造方式。这不影响公开 API 行为，但属于测试宿主兼容性细节，而不是协议本身需求。
