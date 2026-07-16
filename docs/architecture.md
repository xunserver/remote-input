# 远程输入模块目标架构

## 1. 目标与范围

应用侧只面向 `RemoteInputClient`：

```ts
const client = new RemoteInputClient({ clientName: "浏览器" });

await client.connect("http://192.168.1.10:17888");
const { operationId } = await client.sendInput("hello");
```

应用可以订阅状态和通知，但不接触 requestId、心跳、序列化或 Socket.IO event：

```ts
client.subscribeNotification((notification) => {
  console.log(notification.name, notification.body);
});
```

本版本只实现 Socket.IO Transport，不实现普通 WebSocket、BLE 或通用不可靠传输协议。Socket.IO Transport 仍必须在内部实现统一的二进制分帧、重组、滑动窗口、累计 ACK 和超时重传；这些机制属于 Transport，不得泄漏到 Codec 或 Session。

目标是：

- 协议由独立 workspace 统一定义并供 SDK、Server 和测试复用。
- SDK 保持轻量，只提供最终业务 API、状态缓存和通知订阅。
- Server 使用同一套协议 Session，不自行解析或拼装协议报文。
- Socket.IO 只承载 `protocol:frame` 二进制帧；Socket.IO Transport 将完整字节消息拆帧发送并在接收端重组，但不理解 request、operation 或输入文本。
- request、response、notification 和 heartbeat 的职责与标识符严格分开。

## 2. Workspace 划分

目标目录：

```text
packages/
  protocol/                 统一协议核心，唯一事实源
    src/
      definitions/          只定义各层契约，不包含运行时实现
        messages.ts         协议消息、方法和通知类型
        message-codec.ts    MessageCodec 接口
        message-transport.ts MessageTransport 接口
        protocol-session.ts ProtocolSession 契约和事件类型
        index.ts            definitions 公开导出
      implementations/      只实现 definitions 中的契约
        validation.ts       运行时校验
        json-message-codec.ts JSON/UTF-8 Codec
        protocol-session.ts Session 运行时实现
        socket-io-*.ts      Socket.IO Client/Server Transport
        index.ts            implementations 公开导出
      index.ts              根入口，仅重导出 definitions

  sdk/                      面向应用的轻量 SDK
    src/
      remote-input-client.ts
      errors.ts
      types.ts
      index.ts

apps/
  server/                   Socket.IO 对端与输入执行
  client/                   React UI
```

### 2.1 `@remote-copy/protocol`

协议包包含两个相互分离的公开部分。

`@remote-copy/protocol` 和 `@remote-copy/protocol/definitions` 只负责定义：

- `ProtocolMessage` 判别联合。
- Request method、body 和 result 映射。
- Notification name 和 body 映射。
- requestId、operationId 和 heartbeatId 的类型规则。
- `MessageCodec` 接口。
- `MessageTransport` 契约。
- `ProtocolSessionContract`、选项、事件和 handler 类型。

`@remote-copy/protocol/implementations` 只负责实现：

- ID 生成器。
- 消息运行时校验。
- `JsonMessageCodec`。
- `ProtocolSession`。
- 请求超时、Response 关联和断线清理。
- Notification 发送与分发。
- Ping/Pong 和心跳超时。
- Incoming Request handler 注册与 Response 生成。
- Socket.IO Client/Server Transport 适配。

协议包不得负责：

- React 状态。
- 输入历史。
- 系统剪贴板和粘贴。
- HTTP 静态文件服务。
- 产品 UI 错误文案。

### 2.2 `@remote-copy/sdk`

SDK 负责面向应用的少量业务代码：

- `connect(url)`、`disconnect()` 和 `sendInput(text)`。
- 创建 `SocketIoClientTransport` 和 `ProtocolSession`。
- 执行 `session.open`。
- 检查 ready、能力、空文本和 busy 状态。
- 缓存 operation 状态并按 revision 去重。
- 提供 SDK 状态、operation 和原始 notification 订阅。
- 将协议错误映射为稳定的 SDK 错误。

SDK 不重新定义协议类型、Codec、Session 或 Socket.IO Transport。类型和契约从 `@remote-copy/protocol` 引入，运行时类从 `@remote-copy/protocol/implementations` 引入。

### 2.3 `@remote-copy/server`

Server 负责：

- HTTP 静态资源服务。
- 创建 Socket.IO Server。
- 为每个 socket 创建 `SocketIoServerTransport` 和 `ProtocolSession`。
- 注册 `session.open`、`input.submit` 和 `operation.get` handler。
- 管理 operation 队列和状态。
- 执行剪贴板写入和粘贴。
- 使用 `ProtocolSession.notify()` 推送状态和 peer 列表。

Server 不直接调用 `JSON.parse()` 解析协议，也不自行关联 requestId 或处理 Ping/Pong。

## 3. 分层

发送端：

```text
Application
    ↓ sendInput(text)
RemoteInputClient                       @remote-copy/sdk
    ↓ request / subscribe notification
ProtocolSession                         @remote-copy/protocol/implementations
    ↓ ProtocolMessage
MessageCodec contract                   @remote-copy/protocol
    ↓ Uint8Array
SocketIoClientTransport                 @remote-copy/protocol/implementations
    ↓ 拆分为 DATA frame / 接收累计 ACK
Socket.IO "protocol:frame"
Socket.IO
```

接收端：

```text
Socket.IO
    ↓ "protocol:frame"
SocketIoServerTransport                 @remote-copy/protocol/implementations
    ↓ 校验、累计 ACK、按消息边界重组
    ↓ 完整 Uint8Array
MessageCodec contract                   @remote-copy/protocol
    ↓ ProtocolMessage
ProtocolSession                         @remote-copy/protocol/implementations
    ↓ typed request handler
Server Operation Service                @remote-copy/server
    ↓
Input Executor                          @remote-copy/server
```

`MessageCodec` 是无状态组件，可以由 `ProtocolSession` 组合使用，不要求每次发送都创建独立层对象。

## 4. 协议消息

统一消息类型：

```ts
type ProtocolMessage =
  | RequestMessage
  | ResponseMessage
  | NotificationMessage
  | PingMessage
  | PongMessage;
```

这里的消息是应用协议消息，不是 Socket.IO packet 或 Transport frame。Transport 只拆分 Codec 产出的字节消息，不解析这里的消息结构。

### 4.1 Request

Request 表示需要对端处理并返回结果的调用：

```ts
type RequestMessage<M extends ProtocolMethod = ProtocolMethod> = {
  v: 1;
  kind: "request";
  requestId: string;
  method: M;
  body: ProtocolRequestMap[M];
};
```

示例：

```json
{
  "v": 1,
  "kind": "request",
  "requestId": "request-1",
  "method": "input.submit",
  "body": {
    "operationId": "operation-1",
    "text": "hello"
  }
}
```

### 4.2 Response

Response 结束一次 Request，必须携带相同的 requestId：

```ts
type ResponseMessage =
  | {
      v: 1;
      kind: "response";
      requestId: string;
      ok: true;
      body: unknown;
    }
  | {
      v: 1;
      kind: "response";
      requestId: string;
      ok: false;
      error: ProtocolError;
    };
```

Session 必须在发送前登记 pending request，以接受可能早于本地 `send()` Promise 完成的 Response；Response timeout 只在 Transport 确认完整 Request 已交付后开始。这样发送队列和分片重传不会提前耗尽业务响应时间，也不会出现本地已超时但 Request 随后才被送达并执行的情况。

每次 `connect()` 都建立新的 Session generation。重连或断开必须立即清理旧 generation 的 pending request 与心跳；旧连接上已经开始但稍后才完成的异步 Request handler 不得把 Response 发送到新连接。

成功示例：

```json
{
  "v": 1,
  "kind": "response",
  "requestId": "request-1",
  "ok": true,
  "body": {
    "operationId": "operation-1"
  }
}
```

`ProtocolSession` 根据 requestId 找到 pending request，再根据原始 method 校验成功 Response 的 body。

未知、重复或迟到的 Response 不得匹配其他请求。第一版忽略并报告 Session error；后续可以增加指标。

### 4.3 Notification

Notification 是单向通知，不需要 Response，因此不携带 requestId：

```ts
type NotificationMessage<N extends ProtocolNotificationName = ProtocolNotificationName> = {
  v: 1;
  kind: "notification";
  name: N;
  body: ProtocolNotificationMap[N];
};
```

示例：

```json
{
  "v": 1,
  "kind": "notification",
  "name": "operation.status",
  "body": {
    "operationId": "operation-1",
    "revision": 2,
    "state": "processing",
    "stage": "pasting",
    "progress": 70,
    "message": "正在触发粘贴"
  }
}
```

Notification 适合状态广播和观察性事件，不适合发送方必须确认成功的副作用命令。`input.submit` 使用 Request，operation 后续状态使用 Notification。

### 4.4 Ping/Pong

心跳属于 ProtocolSession 控制消息：

```ts
type PingMessage = {
  v: 1;
  kind: "ping";
  heartbeatId: string;
};

type PongMessage = {
  v: 1;
  kind: "pong";
  heartbeatId: string;
};
```

Ping/Pong 不使用 requestId，也不进入普通 pending request Map。

主动心跳的一端负责：

- Session ready 后按 interval 发送 Ping。
- 等待相同 heartbeatId 的 Pong。
- 超时后关闭 Session 和 Transport。
- 拒绝全部 pending request。
- disconnect 时清理 interval 和 timeout。

发送 Ping 前必须先登记本次 `heartbeatId`，以接受可能早于本地 Transport ACK 的 Pong；心跳 timeout 只在 Ping 被 Transport 确认交付后开始。

任何 Session 收到 Ping 都立即回复相同 heartbeatId 的 Pong。Server 第一版作为被动响应端，Client 作为主动检测端，避免双向重复心跳。

Socket.IO 自身的 Engine.IO 心跳负责检测 Socket.IO 连接；协议 Ping/Pong 进一步验证远端 ProtocolSession 仍能处理协议消息。两者语义不同。

## 5. 标识符边界

| 标识 | 所属层 | 用途 |
| --- | --- | --- |
| requestId | ProtocolSession | 关联一次 Request/Response |
| operationId | Remote Input protocol | 关联长期输入操作、查询和状态通知 |
| heartbeatId | ProtocolSession | 关联一次 Ping/Pong |
| Transport `messageId` | Socket.IO Transport | 标识一个待拆分或重组的完整字节消息 |
| Transport `frameSeq` | Socket.IO Transport | 标识一个方向上的 DATA 帧顺序和累计 ACK 位置 |
| Socket.IO packet ID | Socket.IO | Socket.IO 内部机制，不进入应用协议或 Transport 帧格式 |

规则：

- requestId 在本端所有 pending request 中必须唯一。
- Response 必须复用 Request 的 requestId。
- Notification 不携带 requestId。
- heartbeatId 不复用 requestId。
- operationId 由发送端在第一次 `input.submit` 前创建，重试必须复用。
- Server 在执行前按 operationId 去重，防止结果丢失后重试造成重复输入。

如果双方未来都可以主动发 Request，requestId 只需要在“发起方自己的 pending request 集合”中唯一；Response 总是匹配本端发出的 Request，方向本身可以消除两端相同 ID 的歧义。

## 6. 方法和通知

第一版方法：

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

第一版通知：

```ts
type ProtocolNotificationMap = {
  "operation.status": OperationStatus;
  "session.peers": SessionPeersNotification;
};
```

`input.submit` body 包含发送端生成的 operationId：

```ts
type InputSubmitParams = {
  operationId: string;
  text: string;
};
```

Server 接受后返回同一个 operationId。SDK 的 `sendInput()` 在成功 Response 到达时 resolve：

```ts
Promise<{ operationId: string }>
```

这表示 Server 已接受该 operation，不表示已经执行完成。最终状态通过 `operation.status` Notification 推送，应用可通过 SDK 状态或 notification 订阅观察。

## 7. ProtocolSession

目标接口：

```ts
class ProtocolSession {
  constructor(
    transport: MessageTransport,
    options?: ProtocolSessionOptions,
  );

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  request<M extends ProtocolMethod>(
    method: M,
    body: ProtocolRequestMap[M],
  ): Promise<ProtocolResultMap[M]>;

  notify<N extends ProtocolNotificationName>(
    name: N,
    body: ProtocolNotificationMap[N],
  ): Promise<void>;

  handleRequest<M extends ProtocolMethod>(
    method: M,
    handler: ProtocolRequestHandler<M>,
  ): () => void;

  subscribe(listener: ProtocolSessionListener): () => void;
}
```

`ProtocolSession` 同时供 Client 和 Server 使用：

- Client 注册 notification listener，并主动调用 `request()`。
- Server 注册 request handler，并通过 `notify()` 推送事件。
- 双方都能处理 Ping/Pong、Response 和断线清理。

Session 不知道输入如何执行，也不知道底层是 Socket.IO Client 还是 Server socket。

## 8. Codec

统一接口：

```ts
interface MessageCodec {
  encode(message: ProtocolMessage): Uint8Array;
  decode(data: Uint8Array): ProtocolMessage;
}
```

第一版使用 JSON + UTF-8：

```text
ProtocolMessage
    -> JSON.stringify
    -> UTF-8
    -> Uint8Array
```

接收方向必须执行严格 UTF-8、JSON 和结构校验。禁止使用类型断言绕过运行时校验。

JSON 和 Socket.IO 是不同层次：JSON 决定应用协议如何编码成字节，Socket.IO 决定这些字节如何传输。即使 Socket.IO 能直接传对象，本协议仍发送 Codec 生成的 `Uint8Array`，避免 Transport 开始理解应用对象。

## 9. MessageTransport 与 Socket.IO

接口：

```ts
interface MessageTransport {
  readonly kind: string;
  readonly state: TransportState;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: Uint8Array): Promise<void>;
  subscribe(listener: TransportListener): () => void;
}
```

对上契约：

- 可靠、有序地交付完整字节消息。
- 保留消息边界。
- 不因链路内部重试而重复交付消息。
- 报告连接、断开和错误。
- 不解析 ProtocolMessage。

`send(message)` 接受一个完整的 Codec 字节消息。只有该消息的全部 DATA 帧都被对端 Transport 的累计 ACK 确认后，Promise 才能 resolve；这不表示对端 Session 已解析消息，更不表示 Request 对应的业务已经完成。协议 Response 和 `operation.status` Notification 的语义不能由 Transport ACK 替代。

### 9.1 Socket.IO 帧事件与编码

Socket.IO 双端只使用一个事件：

```text
protocol:frame(Uint8Array)
```

事件载荷必须恰好包含一个 DATA 帧或 ACK 帧，不得在一个事件中拼接多个帧，也不为每个 method 建立单独事件。所有多字节整数都使用大端（network byte order）。

DATA 帧固定使用 28-byte header，之后紧跟 payload：

| Offset | 长度 | 字段 | 约束 |
| ---: | ---: | --- | --- |
| 0 | 2 | `magic` | `0x5243` |
| 2 | 1 | `frameVersion` | `1` |
| 3 | 1 | `kind` | `1`，表示 DATA |
| 4 | 4 | `frameSeq` | 当前发送方向的 DATA 帧序号，范围 `0..0xfffffffe` |
| 8 | 4 | `messageId` | 当前连接、当前发送方向内的完整消息标识 |
| 12 | 4 | `chunkIndex` | 从 `0` 开始 |
| 16 | 4 | `chunkCount` | 当前消息总分片数，必须大于 `0` |
| 20 | 4 | `totalMessageBytes` | 重组后完整消息的字节数 |
| 24 | 4 | `payloadBytes` | payload 实际字节数 |
| 28 | `payloadBytes` | `payload` | 当前分片内容 |

ACK 帧固定为 8 bytes：

| Offset | 长度 | 字段 | 约束 |
| ---: | ---: | --- | --- |
| 0 | 2 | `magic` | `0x5243` |
| 2 | 1 | `frameVersion` | `1` |
| 3 | 1 | `kind` | `2`，表示 ACK |
| 4 | 4 | `nextExpectedFrameSeq` | 累计确认此序号之前的全部 DATA 帧，可取 `0xffffffff` |

Client 到 Server 与 Server 到 Client 分别维护独立的 `frameSeq`、`messageId`、发送窗口和接收重组状态。每个新连接的 `frameSeq`、`nextExpectedFrameSeq` 和 `messageId` 都从 `0` 开始，DATA 帧和完整消息分别连续递增；DATA 保留 `0xffffffff` 作为最终累计 ACK 的 exclusive upper bound，因此最大 DATA `frameSeq` 是 `0xfffffffe`。序号不得在同一连接内回绕，耗尽时必须重新连接。ACK 不使用 `messageId`，也不需要 ACK。

### 9.2 拆分、窗口与累计 ACK

Socket.IO Transport 使用 Go-Back-N：

1. `send()` 将完整消息按默认 16 KiB 最大 payload 拆成 DATA 帧，并为帧分配连续的 `frameSeq`。
2. 发送窗口默认允许最多 8 个尚未确认的 DATA 帧。窗口可以跨越发送队列中的消息，但 `messageId`、`chunkIndex` 和 `chunkCount` 必须保留每条消息的边界与原始顺序。
3. 接收端只接收恰好等于本方向 `nextExpectedFrameSeq` 的 DATA 帧；收到重复或越序帧时丢弃 payload，并再次发送当前累计 ACK。
4. 每接受一个连续 DATA 帧，接收端先提交重组与序号状态，再立即发送携带新 `nextExpectedFrameSeq` 的 ACK；若该帧完成消息，ACK 发送后才向 Session 分发完整消息。ACK 必须绕过 DATA 发送窗口、完整消息队列和上层 Session 回调，避免双向窗口互相阻塞，也避免上层监听器延迟或阻止 ACK。
5. 发送端收到推进窗口的累计 ACK 后释放已确认帧并继续填充窗口。重复或未推进的 ACK 不回退发送状态。
6. 最老未确认帧默认等待 ACK 2 秒；超时后从该帧起重传当前所有未确认帧。每批帧最多重传 3 次，耗尽后 Transport 报错并断开。
7. 一个完整消息的最后一帧得到累计确认后，才 resolve 对应的 `send()`；较后消息的窗口发送不能改变 Promise 按各自确认进度完成的语义。

Transport 接收端按 `messageId` 和 chunk 元数据重组，并且只在完整消息的所有分片连续到达、总字节数校验一致后，向 Session 发布一次完整 `Uint8Array`。Session 与 Codec 永远看不到 DATA 或 ACK 帧。
重组开始后若连续 10 秒没有接受到新的连续 DATA 帧，Transport 必须按连接级错误清理并断开，不能保留永久占用内存的半包。

### 9.3 资源限制与错误清理

默认限制为：

| 项目 | 默认值 |
| --- | ---: |
| DATA payload 最大值 | 16 KiB |
| DATA 发送窗口 | 8 帧 |
| ACK timeout | 2 秒 |
| 最大重传次数 | 3 次 |
| 重组无进展 timeout | 10 秒 |
| 单条完整消息 | 256 KiB |
| 待发送完整消息数 | 128 条 |
| 待发送完整消息总字节数 | 4 MiB |

完整消息在拆分前先检查 256 KiB 限制。发送队列统计正在发送以及等待 ACK 的全部未完成消息，并同时执行 128 条和 4 MiB 两项上限；超过任一上限时拒绝新的 `send()`，不得静默丢弃旧消息。

实现选项只允许为测试或更严格的宿主约束调低 16 KiB chunk、8 帧窗口、3 次重传、10 秒重组 timeout 和三项资源上限，不得配置成突破本节上限的值。ACK timeout 可以调整，但必须是宿主计时器可准确表示的正整数毫秒值，最大为 `2^31-1`。若两端调低 chunk 大小，必须使用相同值；当前 Transport frame version 不包含 chunk 大小协商。

入站 Socket.IO packet 必须先按当前 chunk 上限检查编码后总长度（ACK 固定 8 bytes，DATA 不得超过 28-byte header 加一个 chunk），再解析 header 或复制 payload，避免非法大帧在拒绝前造成额外内存放大。收到 magic、版本、kind、header 长度、payload 长度、分片索引或消息总长度非法，连续帧的消息元数据互相矛盾，或者 ACK 超过已发送序号范围时，Transport 必须报告错误并断开。单纯重复或越序的合法 DATA 帧仍按 Go-Back-N 规则丢弃并回复当前累计 ACK。断线、非法帧或重传耗尽都必须清空发送窗口、完整消息队列、重组缓存和计时器，并 reject 所有尚未完成的 `send()`。旧连接迟到的帧不得进入新连接状态。

这些 Transport ACK 只证明对端 Transport 已接收对应字节帧，不使用 Socket.IO event ACK，也绝不能替代协议 Response。request/response/notification/heartbeat 的语义仍全部由协议包统一管理，Server 与未来其他对端实现可以复用相同 Session。

Client Transport 负责创建 `socket.io-client` socket；Server Transport 包装 Socket.IO Server 提供的单个 socket。Server Transport 创建时已经 connected，`connect()` 只完成适配器启动。

第一版关闭 Socket.IO Client 自动重连。一次 socket 连接对应一次 ProtocolSession；重连由 SDK 显式创建新 Session，避免旧 pending request 和旧 Session 状态进入新连接。

## 10. SDK API

SDK 对外主要接口：

```ts
class RemoteInputClient {
  constructor(options?: RemoteInputClientOptions);

  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;

  sendInput(text: string): Promise<{ operationId: string }>;

  getState(): RemoteInputState;
  subscribe(listener: RemoteInputStateListener): () => void;

  getOperationStatus(operationId: string): OperationStatus | null;
  refreshOperationStatus(operationId: string): Promise<OperationStatus>;
  subscribeOperation(
    operationId: string,
    listener: OperationStatusListener,
  ): () => void;

  subscribeNotification(
    listener: ProtocolNotificationListener,
  ): () => void;
}
```

SDK 可以为测试保留内部/高级 Transport factory 注入，但普通调用方只传 Socket.IO URL，不需要构造 Transport。

## 11. Server 会话

每个 Socket.IO connection 对应：

```text
SocketIoServerTransport
    +
ProtocolSession
    +
registered request handlers
```

Server 建立连接后先注册 handler：

```ts
session.handleRequest("session.open", handleSessionOpen);
session.handleRequest("input.submit", handleInputSubmit);
session.handleRequest("operation.get", handleOperationGet);
```

然后启动 Session。除 `session.open` 外的请求在会话打开前返回 `session.required`。

`input.submit`：

1. 校验 Session 已打开、operationId 和文本。
2. 如果 operationId 已存在，返回已有 operationId，不重复执行。
3. 创建 operation 并返回成功 Response。
4. 进入执行队列。
5. 使用 `operation.status` Notification 推送 revision 递增的状态。

## 12. 状态、并发和幂等

公共 operation state 保持：

```text
accepted -> processing -> succeeded
     |           |
     +-----------+-----> failed
```

- `accepted`：Server 已接受并持久于当前内存存储。
- `processing`：Server 正在执行。
- `succeeded`：当前协议下游完成自身职责。
- `failed`：当前协议下游执行失败。

每次更新携带递增 revision。SDK 只接受更新 revision，Server 对重复 operationId 返回已有状态。

第一版 SDK 保持单个活动输入 operation，避免 UI 和执行队列的并发语义不明确。`ProtocolSession` 本身允许不同 requestId 的并发请求。

## 13. 资源与安全限制

第一版至少需要：

- 最大输入 UTF-8 字节数。
- 最大协议消息字节数。
- Transport 单帧 payload、发送窗口、完整消息队列条数和总字节数上限。
- Transport ACK 超时、重传上限和接收重组缓存清理。
- 最大 pending request 数。
- 每个 Session 的请求超时。
- operation Map 和执行队列上限。
- clientName 最大长度。
- 非法消息关闭或拒绝策略。
- 默认不记录输入全文。

远程输入具有副作用。Socket.IO 连接成功不等于获得输入权限。公开部署还需要 TLS、Origin、认证、授权和速率限制；这些不是 requestId 或 Socket.IO 心跳能够替代的。

## 14. 公共导出

协议包的导入示例、契约完成语义和自定义实现要求见 [协议包定义与实现](../packages/protocol/README.md)。

`@remote-copy/protocol` 根入口以及 `/definitions` 只导出定义：

```text
协议：
  ProtocolMessage
  RequestMessage
  ResponseMessage
  NotificationMessage
  PingMessage
  PongMessage
  ProtocolRequestMap / ProtocolResultMap
  ProtocolNotificationMap
  ProtocolError
  OperationStatus 等领域类型

接口：
  MessageCodec
  MessageTransport
  ProtocolSessionContract
  ProtocolSessionOptions / ProtocolSessionEvent
  TransportState / TransportEvent
```

`@remote-copy/protocol/implementations` 只导出运行时实现：

```text
  parseProtocolMessage
  parseResultBody
  ProtocolValidationError
  JsonMessageCodec
  ProtocolSession
  ProtocolResponseError
  SocketIoClientTransport
  SocketIoServerTransport
```

`@remote-copy/sdk` 导出：

```text
RemoteInputClient
SendInputError
RemoteInputClientOptions
RemoteInputState
SDK listener 和 error 类型
常用 operation / peer / notification 类型重导出
```

需要定义边界时依赖 `@remote-copy/protocol`；需要使用标准运行时实现时显式依赖 `@remote-copy/protocol/implementations`；普通应用只依赖 `@remote-copy/sdk`。

## 15. 测试边界

### 协议包

- 所有 Request、成功/失败 Response、Notification、Ping/Pong 的解析。
- 非法版本、kind、method、name、body 和 ID。
- JSON/UTF-8 round trip 与非法输入。
- requestId 关联、重复 ID、超时、断线清理。
- incoming request handler 的成功、协议错误和未知 method。
- notification 发送与分发。
- Ping/Pong、心跳超时和计时器清理。
- Socket.IO Client/Server Transport 的 DATA/ACK 编解码、16 KiB 拆分和完整消息重组。
- Go-Back-N 累计 ACK、8 帧窗口、跨消息发送、2 秒超时和最多 3 次重传。
- ACK 绕过 DATA 窗口、`send()` 确认时机、双向独立状态和消息顺序。
- 256 KiB 单消息与 128 条/4 MiB 队列限制。
- 非法帧、断线、重传耗尽和旧连接迟到事件的清理。

### SDK

- URL 连接和 `session.open`。
- `sendInput()` 校验、能力检查和 operationId 生成。
- operation revision 去重。
- SDK 状态、operation 和 notification 订阅。
- 协议/Transport 错误映射。

### Server

- `session.open` 前拒绝其他请求。
- 重复 operationId 不重复入队。
- operation 查询权限和状态。
- notification 推送。
- Socket.IO 实际连接的 `session.open` 集成测试。

自动验证不得向真实 Server 发送非空 `input.submit`，避免意外修改本机剪贴板或触发粘贴。

## 16. 架构决策摘要

| 决策 | 原因 |
| --- | --- |
| 新增独立 `@remote-copy/protocol` | SDK 与 Server 必须共享类型、校验和 Session 行为 |
| SDK 保持轻量 | 应用 API 与通用协议机制具有不同变化原因 |
| Request/Response/Notification/Ping/Pong 属于 Session | 它们是应用协议语义，不是 Transport packet |
| Notification 没有 requestId | 它不要求 Response，长期状态用 operationId 关联 |
| 心跳使用 heartbeatId | 不占用普通 RPC pending request，也不混淆 requestId |
| Codec 统一产出 `Uint8Array` | Socket.IO 不直接接触应用对象，未来编码可替换 |
| Socket.IO 只传 `protocol:frame` | 用单一二进制帧事件承载 DATA 和累计 ACK，不把方法语义分散到 event 名称中 |
| Socket.IO Transport 使用 Go-Back-N | 所有完整消息统一经过拆帧、窗口、累计 ACK、重传和重组 |
| Transport ACK 不替代 Response | 字节交付与协议请求处理是不同的完成语义 |
| Client 主动心跳、Server 被动 Pong | 避免双向重复定时器，仍验证远端 Session 活性 |
| 第一版关闭自动重连 | 一次连接绑定一次 Session，失败和清理语义明确 |
| operationId 由发送端创建 | 支持结果不确定时以相同 ID 安全重试 |
| 可靠传输留在 MessageTransport 内 | Session/Codec 只处理完整消息，不新增同时承担协议与传输职责的 Channel 抽象 |
