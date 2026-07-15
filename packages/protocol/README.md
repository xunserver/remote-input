# @remote-copy/protocol

`@remote-copy/protocol` 同时承担两件彼此分离的事情：

1. 定义远程输入协议各层的类型、消息和行为契约；
2. 提供当前项目采用的 JSON、ProtocolSession 和 Socket.IO 标准实现。

定义不依赖具体实现。业务包可以只依赖契约，也可以按需引入标准实现。

## 导入入口

```ts
// 定义入口：只有类型、接口和协议常量，不会引入运行时实现。
import {
  protocolVersion,
  type MessageCodec,
  type MessageTransport,
  type ProtocolSessionContract,
} from "@remote-copy/protocol";

// 与根入口等价的显式写法。
import type { ProtocolMessage } from "@remote-copy/protocol/definitions";

// 实现入口：按需引入默认实现。
import {
  JsonMessageCodec,
  ProtocolSession,
  SocketIoClientTransport,
} from "@remote-copy/protocol/implementations";
```

不要从 definitions 反向依赖 implementations，也不要让 Transport 解析应用协议。

## 分层

```text
应用 / SDK
  -> ProtocolSession
    -> MessageCodec
      -> MessageTransport
```

### 应用协议消息

`messages.ts` 定义跨端共享的应用语义：

- `request`：发起一次有结果的调用，使用 `requestId` 关联响应；
- `response`：返回请求结果，必须携带原请求的 `requestId`；
- `notification`：单向通知，不产生响应，也没有 `requestId`；
- `ping` / `pong`：Session 使用 `heartbeatId` 检查对端活性。

方法和通知由映射类型统一登记：

```ts
type ProtocolRequestMap = {
  "session.open": SessionOpenParams;
  "input.submit": InputSubmitParams;
  "operation.get": OperationGetParams;
};

type ProtocolResultMap = {
  "session.open": SessionOpenResult;
  "input.submit": InputSubmitResult;
  "operation.get": OperationStatus;
};
```

同一方法的请求体和结果通过相同键关联，因此调用端、处理端和解析器可以共享类型约束。新增方法或通知时，应同时更新映射、运行时校验、两端实现和测试。

### ProtocolSession

Session 在消息层之上提供：

- 生成 `requestId` 并关联 Request/Response；
- 管理请求超时和未完成请求数量；
- 注册请求处理器并发送成功或失败响应；
- 分发 Notification；
- 主动启停心跳并检测超时；
- 在 Transport 断开时清理未完成请求。

`connect()` 只表示底层 Transport 已连接，不表示 `session.open` 已完成。SDK 应在连接后显式调用 `session.open`。心跳也必须通过 `startHeartbeat()` 显式启动。

### MessageCodec

Codec 只负责 `ProtocolMessage` 与 `Uint8Array` 的双向转换。默认的 `JsonMessageCodec` 使用 UTF-8 JSON，并在解码时执行运行时校验。

Codec 不负责：

- 请求响应关联；
- 超时、队列或心跳；
- Transport 的分片、重组、ACK 和重试。

### MessageTransport

Session 面向的是一个可靠、有序、保留消息边界的双工字节消息通道：

```ts
interface MessageTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: Uint8Array): Promise<void>;
  subscribe(listener: TransportListener): () => void;
}
```

这是一项上层契约，而不是对物理链路的假设。Socket.IO 可以直接满足该契约；未来蓝牙实现则必须在 Transport 内部完成 GATT 适配、MTU 分片、重组、ACK、重试和顺序恢复，再向 Session 暴露完整消息。

`send()` 完成仅表示消息已被 Transport 接受并完成本层发送，不代表对端已解析、处理或完成业务操作。业务完成状态由 Response 或 `operation.status` Notification 表达。

## 标识符边界

协议中的标识符用途不能混用：

| 标识符 | 所属层 | 生命周期与作用 |
| --- | --- | --- |
| `requestId` | Session | 关联一次 Request/Response，响应后释放 |
| `operationId` | 应用协议 | 关联长期输入操作、查询和状态通知 |
| `heartbeatId` | Session | 关联一次 Ping/Pong 活性检查 |
| 分片序号、ACK 序号 | Transport | 仅用于具体 Transport 的可靠消息实现 |

`input.submit` 的 `operationId` 由发送方生成，重试同一业务操作时应复用它；重新发起一次独立请求时会生成新的 `requestId`。

## Operation 状态

公共状态固定为：

```text
accepted -> processing -> succeeded | failed
```

`revision` 必须递增，用于忽略乱序或重复状态；`stage` 描述具体下游阶段；`succeeded` 只代表当前协议下游已经完成其职责。

## 使用标准实现

```ts
import { ProtocolSession } from "@remote-copy/protocol/implementations";
import { SocketIoClientTransport } from "@remote-copy/protocol/implementations";

const transport = new SocketIoClientTransport({ url: "http://localhost:17888" });
const session = new ProtocolSession(transport);

await session.connect();
await session.request("session.open", { clientName: "browser" });
session.startHeartbeat();
```

## 提供自定义实现

自定义 Transport 只需要满足 definitions 中的契约。比如蓝牙 Transport 应在内部把任意大小的字节消息转换为适配 MTU 的帧，并且仅在完整消息重组后触发 `message` 事件：

```ts
import type {
  MessageTransport,
  TransportListener,
  TransportState,
} from "@remote-copy/protocol";

class BluetoothTransport implements MessageTransport {
  readonly kind = "bluetooth";
  state: TransportState = "idle";

  async connect(): Promise<void> {
    // 建立 GATT 连接并准备可靠消息通道。
  }

  async disconnect(): Promise<void> {}

  async send(message: Uint8Array): Promise<void> {
    // 分片、窗口、ACK 和重试都封装在 Transport 内部。
  }

  subscribe(listener: TransportListener): () => void {
    // 只向上层发布完整的 Uint8Array 消息和连接状态。
    return () => {};
  }
}
```

自定义 Codec 同理，只需实现 `MessageCodec`，并确保 `decode()` 对不可信输入进行完整校验，不能用类型断言替代运行时检查。

## 版本、限制与校验

- 每个 Wire Message 都携带 `v`，当前版本为 `protocolVersion`；
- `maxProtocolMessageBytes` 限制 Codec 接收的完整协议消息；
- `maxInputBytes` 限制输入文本的 UTF-8 字节数；
- `maxPendingRequests` 防止无限堆积未完成请求；
- implementations 的解析器是网络输入进入类型系统的信任边界。

协议变更至少需要验证：请求、成功/失败响应、通知、心跳和非法报文。

```bash
pnpm test:protocol
pnpm test:sdk
pnpm test:server
pnpm check
pnpm build
```
