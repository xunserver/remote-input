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

Session 会在发送前登记 request/heartbeat 关联状态，以接受早于本地 Transport ACK 的 Response 或 Pong；Response/Pong timeout 只在对应完整消息被 Transport 确认交付后开始，发送排队和分片重传时间不计入上层响应 timeout。

每次 `connect()` 都会替换 Session generation，并清理旧连接的 pending request 和心跳。旧 generation 上尚未结束的异步 Request handler 即使随后完成，也不会把旧 Response 写入新连接。

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

这是一项上层契约，而不是对物理链路的假设。当前 Socket.IO 实现必须在 Transport 内部完成二进制分帧、重组、窗口、累计 ACK、重试和顺序恢复；未来蓝牙实现也必须在自身 Transport 内完成相应的 GATT/MTU 适配。任何 Transport 都只能向 Session 暴露完整消息。

`send()` 只有在完整消息的所有帧都被对端 Transport ACK 后才完成。它仍不代表对端 Session 已解析、处理或完成业务操作；Request 必须等待协议 Response，长期业务状态由 `operation.status` Notification 表达。Transport ACK 不得替代这些上层语义。

### Socket.IO Transport 帧协议

Client 与 Server Transport 只通过单一 Socket.IO 事件传输帧：

```text
protocol:frame(Uint8Array)
```

事件载荷恰好是一帧。所有多字节整数使用大端（network byte order）。DATA 帧是 28-byte header 加 payload：

| Offset | 长度 | 字段 | 值或语义 |
| ---: | ---: | --- | --- |
| 0 | 2 | `magic` | `0x5243` |
| 2 | 1 | `frameVersion` | `1` |
| 3 | 1 | `kind` | `1`（DATA） |
| 4 | 4 | `frameSeq` | 当前方向的连续帧序号，范围 `0..0xfffffffe` |
| 8 | 4 | `messageId` | 完整消息标识 |
| 12 | 4 | `chunkIndex` | 从 `0` 开始的分片索引 |
| 16 | 4 | `chunkCount` | 消息总分片数 |
| 20 | 4 | `totalMessageBytes` | 完整消息字节数 |
| 24 | 4 | `payloadBytes` | 当前 payload 字节数 |
| 28 | `payloadBytes` | `payload` | 分片数据 |

ACK 帧固定 8 bytes：

| Offset | 长度 | 字段 | 值或语义 |
| ---: | ---: | --- | --- |
| 0 | 2 | `magic` | `0x5243` |
| 2 | 1 | `frameVersion` | `1` |
| 3 | 1 | `kind` | `2`（ACK） |
| 4 | 4 | `nextExpectedFrameSeq` | 累计确认该序号之前的全部 DATA 帧，可取 `0xffffffff` |

默认实现使用 Go-Back-N：DATA payload 最大 16 KiB，发送窗口 8 帧，ACK timeout 2 秒，最多重传 3 次，接收重组连续 10 秒无进展时失败。ACK 绕过 DATA 窗口和完整消息队列，且不对 ACK 再发送 ACK。窗口允许跨越队列中的多条消息，Transport 使用 `messageId`、`chunkIndex` 和 `chunkCount` 保持消息边界及顺序。每个新连接的双向 `frameSeq`、`nextExpectedFrameSeq` 和 `messageId` 都独立从 `0` 开始连续递增，不在连接内回绕；DATA 最大序号为 `0xfffffffe`，`0xffffffff` 只作为最终累计 ACK 的 exclusive upper bound。

接收端只接收当前连续的 `frameSeq`，对重复或越序 DATA 丢弃 payload 并重发当前累计 ACK。连续帧先提交重组与序号状态并发送 ACK；若它完成消息，ACK 后才向 Session 发布一次完整 `Uint8Array`，因此上层监听器不能延迟或阻止 Transport ACK。两个发送方向分别维护序号、窗口和重组状态。

单条完整消息最大 256 KiB。发送队列统计正在发送和等待 ACK 的全部消息，最多 128 条、合计最多 4 MiB，超过任一限制时拒绝新 `send()`。断线、非法帧或重传耗尽时，Transport 必须清空发送队列、窗口、接收重组缓存和计时器，并拒绝全部未完成的 `send()`。

`SocketIoTransportOptions` 可为测试或更严格的宿主资源约束调低 chunk、窗口、重传、重组 timeout 和容量限制，但不能突破上述协议上限。`ackTimeoutMs` 可以调整，但必须是 `1..2^31-1` 范围内的整数毫秒值；Client 的 `connectTimeoutMs` 采用相同计时器范围。若调低 `chunkPayloadBytes`，同一连接的 Client 与 Server 必须配置成相同值；当前帧协议不协商 chunk 大小。入站 packet 会先检查编码后总长度，再解析并复制合法 payload，非法大帧不会在 Transport 内被重复完整复制。

## 标识符边界

协议中的标识符用途不能混用：

| 标识符 | 所属层 | 生命周期与作用 |
| --- | --- | --- |
| `requestId` | Session | 关联一次 Request/Response，响应后释放 |
| `operationId` | 应用协议 | 关联长期输入操作、查询和状态通知 |
| `heartbeatId` | Session | 关联一次 Ping/Pong 活性检查 |
| `messageId`、`frameSeq`、ACK 序号 | Transport | 只用于字节消息拆分、重组、窗口和可靠交付 |

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

const transport = new SocketIoClientTransport("http://localhost:17888");
const session = new ProtocolSession(transport);

await session.connect();
await session.request("session.open", { clientName: "browser" });
session.startHeartbeat();
```

## 提供自定义实现

自定义 Transport 只需要满足 definitions 中的契约。比如蓝牙 Transport 应在内部把契约允许的完整字节消息转换为适配 MTU 的帧，并且仅在完整消息重组后触发 `message` 事件：

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
    // 分片、窗口、ACK 和重试都封装在 Transport 内部；完整消息确认后返回。
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
- Socket.IO Transport 默认限制为 16 KiB payload、8 帧窗口、2 秒 ACK timeout 和 3 次重传；
- Socket.IO Transport 限制单消息 256 KiB，发送队列最多 128 条且总计最多 4 MiB；
- implementations 的解析器是网络输入进入类型系统的信任边界。

协议变更至少需要验证请求、成功/失败响应、通知、心跳和非法报文；Transport 变更还必须验证帧编解码、拆分重组、窗口、累计 ACK、重传、资源上限及断线/非法帧清理。

```bash
pnpm test:protocol
pnpm test:sdk
pnpm test:server
pnpm check
pnpm build
```
