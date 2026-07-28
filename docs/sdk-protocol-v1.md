# SDK Request/Response 协议 V1 设计与实现基线

> 状态：V1 分片扩展验收稿；协议行为与测试容量、时间常量以当前实现为准
> 范围：WebSocket Transport、双向 Session Request/Response、SDK Client  
> 注意：多 Chunk 帧与旧的固定单 Chunk 接收端不兼容，客户端和服务端必须同步升级；本文与当前仓库实现一致。

## 阅读导航

- 第 1～5 节：目标、分层、包边界与初始化。
- 第 6～13 节：Session 数据模型、请求状态机与 Handler。
- 第 14～21 节：Transport 接口、帧、FIFO、ACK、去重与内部取消。
- 第 22～26 节：断线、关闭、错误、完整时序与协议不变量。
- 第 27～30 节：测试矩阵、实现与验收顺序、V2 TODO 与 V1 常量。

## 1. 目标

V1 要建立一套分层清晰、可判断交付结果、可双向调用的 Request/Response 协议：

- SDK Client 向业务暴露 sendText 等易用方法。
- Session 负责请求 ID、Pending 请求、超时、Handler 路由和 Response 匹配。
- Transport 负责把一条完整的 Session JSON 报文可靠地交给对端 Session。
- WebSocket 只作为更底层的链路能力；Transport 仍然使用统一的 DATA/ACK/Chunk 规范。
- 两端完全对称：客户端和服务端都可以主动发起 Request。
- Session 不自动重发业务请求。错误交给上层，由上层决定是否重试。

V1 的核心交付语义是：

1. Transport.send 成功，只表示对端 Transport 已收到完整报文，并已同步交给对端 Session。
2. SDK 请求成功，表示 Request 已传输、对端 Handler 已处理，并且 Response 已返回。
3. Transport ACK 不代表业务处理成功。

## 2. 非目标

以下能力不进入 V1：

- notify、topic、订阅、取消订阅、通知重放。
- HTTP、蓝牙等其他 Transport 的具体实现。
- 多个逻辑 transfer 并行发送、动态拥塞控制或跨连接恢复 partial transfer。
- Session 自动重试 Request。
- 用户主动取消请求。
- 单次请求覆盖默认超时时间。
- Handler 并发上限。
- PendingMap 数量上限。
- Response 优先队列。
- 协议版本协商。
- 跨连接恢复旧的 Transport 队列或旧的 Pending 请求。
- 身份认证、授权、限流、压缩和端到端加密。

## 3. 分层与所有权

~~~text
业务代码
  │
  ▼
SDK Client
  │  sendText(...) / request(...)
  ▼
Session
  │  SessionMessage（逻辑 JSON）
  ▼
Transport
  │  编码、准入、FIFO、DATA/ACK、重试、去重
  ▼
WebSocket Link
  │  字符串或二进制帧
  ▼
对端
~~~

### 3.1 SDK Client

Client：

- 提供 sendText 等业务友好的类型化方法。
- 可以保留一个通用 request 方法，供未封装的方法使用。
- 创建 Session，并把 Transport 绑定给 Session。
- 不提供 connect 方法。
- close 时先清理 Client 自己的资源，再关闭 Session。
- close 后永久不可复用。

### 3.2 Session

Session：

- 生成和维护 requestId。
- 在 PendingMap 中保存 resolve、reject、timer 和内部取消句柄。
- 负责 Request/Response 的编码前结构、匹配、Handler 调度和安全错误转换。
- 管理默认端到端请求超时。
- 监听 Transport 断开，并拒绝所有仍在等待的请求。
- 不关心 WebSocket 对象、Chunk、ACK 或重试次数。
- 不自动重发 Request。

### 3.3 Transport

Transport：

- 接收一条 Session JSON 报文。
- 立即编码并冻结发送快照。
- 按固定限制做大小和队列准入检查。
- 严格按消息 FIFO 发送。
- 维护 connection generation 和 connection-local transferId。
- 实现 DATA/ACK、ACK 超时、有限重试和接收端去重。
- 在链路断开时清空本连接的发送工作。
- 拥有并管理 WebSocket Link。

Transport 不等待远端业务 Handler 完成。

### 3.4 WebSocket Link

WebSocket Link 只提供底层连接与帧收发能力。它不理解：

- requestId；
- Request/Response；
- Handler；
- SDK 方法；
- 端到端请求超时。

### 3.5 一对一关系

V1 中，一个活跃 Transport 只绑定一个 Session，一个 Session 只使用一个 Transport。

Transport 被 Client/Session 使用期间，不允许其他代码绕过 Session 直接调用 Transport.send 发送业务 DATA。ACK、CLOSE 等控制帧只由 Transport 内部产生。

## 4. 包边界

V1 采用两个职责单一的 workspace 包：

~~~text
packages/
  protocol/
    Session 消息、错误、Session runtime
    Transport 接口、WebSocket Transport、测试工具
  sdk/
    面向业务的 Client 和 sendText 等封装
~~~

- @remote-input/protocol 不依赖业务应用。
- @remote-input/sdk 通过 workspace:* 依赖 @remote-input/protocol。
- 每个包拥有自己的 build、check、test 脚本。
- 根脚本只通过 turbo run 委派任务，不把具体实现命令堆到根目录。

当前仓库已经按此结构实现，并由根目录 Turborepo 任务统一构建和验证。

## 5. 初始化与连接

推荐且安全的顺序是先绑定上层，再建立连接：

~~~ts
const transport = new WebSocketTransport(url);

const client = new Client({
  transport,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
});

await transport.connect();
await client.sendText("hello");
~~~

规则：

- Client 不代理 connect。
- connect 属于 Transport。
- 如果先 connect、后创建 Client，无 receiver 时只丢弃当次 DATA 帧且不得 ACK；发送端可能重试，并在绑定完成后成功，也可能最终失败。
- 未连接时调用 Client 方法，最终由 Transport 立即以 TRANSPORT_NOT_CONNECTED 拒绝。
- 短暂断线后，调用者直接对同一个 Transport 执行 connect；不需要重新 connect Client。
- 显式 client.close 后，旧 Client 和旧 Session 永久失效。V1 WebSocketTransport 完整 close/reset 后可以复用：先把它绑定到新 Client/Session，再由调用者执行 transport.connect。

服务端如何把一个新 WebSocket 映射到逻辑连接、用户身份或 Session 工厂，属于连接接入层职责，不由 Session 协议定义。

## 6. JSON 数据模型

Session 只接受 JSON 可表示的数据。

~~~ts
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
~~~

不允许在协议数据中出现：

- undefined；
- bigint；
- function；
- symbol；
- 循环引用；
- NaN 和 Infinity 等不能稳定表达的值。

Handler 正常返回 undefined 时，Session 将它规范化为 null。其他不可序列化结果转为安全错误 Response。

JSON.stringify 不是数据校验器：它会静默删除某些对象字段，并把部分非法数值改成 null。因此 V1 必须提供递归运行时 JsonValue 校验，并在 stringify 前执行：

- Request 或其他本地出站数据非法：Transport 以 ENCODE_ERROR、delivery: not_sent 拒绝。
- Handler 返回 undefined：Session 规范化为 null。
- Handler 返回其他非法值：Session 不构造成功 Response，改为 RESPONSE_NOT_SERIALIZABLE 错误 Response。

校验必须覆盖嵌套对象和数组，并拒绝 undefined、bigint、function、symbol、循环引用、NaN、Infinity 和 -Infinity。

## 7. Session 报文

V1 不带 version 字段。

### 7.1 Request

~~~ts
export type RequestMessage = {
  type: "request";
  requestId: number;
  method: string;
  payload: JsonValue;
};
~~~

示例：

~~~json
{
  "type": "request",
  "requestId": 42,
  "method": "sendText",
  "payload": {
    "text": "hello"
  }
}
~~~

### 7.2 成功 Response

~~~ts
export type SuccessResponseMessage = {
  type: "response";
  requestId: number;
  ok: true;
  data: JsonValue;
};
~~~

### 7.3 失败 Response

~~~ts
export type ErrorResponseMessage = {
  type: "response";
  requestId: number;
  ok: false;
  error: {
    code: string;
    message?: string;
    details?: JsonValue;
  };
};

export type ResponseMessage =
  | SuccessResponseMessage
  | ErrorResponseMessage;

export type SessionMessage = RequestMessage | ResponseMessage;
~~~

远端错误不得包含原始 Error 对象、调用栈或敏感内部信息。

### 7.4 requestId

- requestId 由发起 Request 的 Session 生成。
- 每个新 Session 的第一个 requestId 为 1。
- 在一个 Session 生命周期内单调递增。
- Transport 断开再连接时不重置。
- 新 Session 可以从初始值重新开始。
- 两个方向各自计数，因此两端同时使用 requestId = 1 是合法的。
- requestId 与 Transport 的 transferId 没有任何关系。
- 线上 requestId 必须是 1 到 Number.MAX_SAFE_INTEGER 之间的安全整数，否则 Session 把报文视为字段非法。
- 达到 Number.MAX_SAFE_INTEGER 前必须关闭当前 Session 并创建新 Session，不允许回绕复用。

## 8. Client 与 Session 对外契约

下列接口用于说明职责，不要求实现时逐字一致：

~~~ts
export interface ClientOptions {
  transport: Transport;
  /**
   * 省略时使用 SDK 的 DEFAULT_REQUEST_TIMEOUT_MS。
   */
  requestTimeoutMs?: number;
}

export interface Client {
  sendText(text: string): Promise<JsonValue>;
  request(method: string, payload: JsonValue): Promise<JsonValue>;
  registerHandler(method: string, handler: RequestHandler): () => void;
  close(): Promise<void>;
}

export type RequestHandler = (
  payload: JsonValue,
  context: {
    requestId: number;
    method: string;
  },
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface SessionOptions {
  requestTimeoutMs: number;
}

export interface Session {
  request(method: string, payload: JsonValue): Promise<JsonValue>;

  registerHandler(
    method: string,
    handler: RequestHandler,
  ): () => void;

  close(): Promise<void>;
}
~~~

sendText("hello") 等价于 request("sendText", { text: "hello" })；它只做类型化映射，不改变 Session 或 Transport 语义。registerHandler 使 Client 侧也能接收对端主动 Request。

规则：

- requestTimeoutMs 在创建 Client/Session 时配置。
- requestTimeoutMs 必须是大于 0 的有限毫秒数；非法配置在构造 Client 时立即失败。
- V1 不提供单次请求 timeout 参数。
- V1 不向 SDK 使用者暴露 AbortSignal 或 cancel。
- 同一个 method 后注册的 Handler 替代先注册的 Handler。
- registerHandler 返回的反注册函数必须带注册令牌；旧 Handler 的反注册函数不能误删后来替换它的新 Handler。
- 已经开始执行的旧 Handler 不会因为替换或反注册而中止。

## 9. Session 发起请求

Session.request 必须按以下顺序工作：

1. 检查 Session 是否仍可用。
2. 生成 requestId。
3. 创建 RequestMessage。
4. 创建内部 AbortController；它只用于 Session 控制 Transport 工作，不对 SDK 暴露。
5. 计算绝对截止时间 deadlineAt，并创建端到端超时 timer。
6. 在调用 Transport.send 前，把 resolve、reject、timer、deadlineAt、deliveryState、AbortController 放入 PendingMap；deliveryState 初始为 not_sent。
7. 调用 Transport.send。
8. 等待 Response、发送失败、断开、超时或 close 中最先到达的终态。

伪代码：

~~~ts
function request(method: string, payload: JsonValue): Promise<JsonValue> {
  assertOpen();

  const requestId = nextRequestId++;
  const message = { type: "request", requestId, method, payload };
  const controller = new AbortController();
  const deadlineAt = clock.now() + requestTimeoutMs;

  return new Promise((resolve, reject) => {
    const timer = clock.setTimeout(
      () => settle(requestId, {
        kind: "reject",
        error: new RequestTimeoutError(),
      }),
      requestTimeoutMs,
    );

    pendingMap.set(requestId, {
      resolve,
      reject,
      timer,
      deadlineAt,
      deliveryState: "not_sent",
      controller,
    });

    void transport
      .send(message, {
        signal: controller.signal,
        deadlineAt,
        onDeliveryChange(delivery) {
          pendingMap.get(requestId)?.setDelivery(delivery);
        },
      })
      .catch((error) => {
        settle(
          requestId,
          mapInternalDeadlineToRequestTimeout(error),
        );
      });
  });
}
~~~

这里的 signal 和 deadlineAt 都是 Session 与 Transport 之间的内部机制，不是公共 SDK 能力。

## 10. 唯一终态与竞态

一个请求只能完成一次。Response、Transport 失败、断开、超时和 close 之间采用“第一个有效终态获胜”。Timeout 在绝对 deadlineAt 时刻即视为发生，不以 timer callback 的调度顺序为准；因此 now >= deadlineAt 后观察到的 Response 不能越过截止时间获胜。

统一 settle 操作必须：

1. 原子地检查 Pending 是否仍存在。
2. 读取该 Pending 当前的 deliveryState。
3. 先从 PendingMap 删除。
4. 清理 timer。
5. 中止该请求尚未结束的 Transport 发送/重试。
6. 最后调用 resolve 或带有当前 delivery 的 reject。

这保证：

- Response 先到、Transport ACK 后丢失时，请求仍成功，后续发送失败被忽略。
- Transport 失败后迟到的 Response 被忽略。
- Timeout 与 Response 同时发生时只有一个结果。
- Close、Disconnect 与 Response 竞争时只有一个结果。
- 重复 Response 不会重复 resolve。

收到 Response 后中止尚未结束的 Transport.send 是安全的，因为 Response 本身已经证明 Request 到达了远端 Session。这个中止只用于停止本地等待 ACK 或重试，不会撤销远端 Handler。

## 11. 端到端超时

Session 的默认超时从调用 session.request 的时刻开始，覆盖：

- JSON 编码；
- Transport 队列等待；
- Request 交付；
- 远端 Handler 执行；
- Response 排队；
- Response 交付。

Session 保存绝对 deadlineAt，不能只依赖事件循环 timer。Transport 在递归校验/编码后、入队前、每次真正发送前和每次重试前都检查 deadlineAt。若同步编码跨过截止时间，则不得入队或发送；Transport 返回内部 deadline 结果，由 Session 统一映射为 REQUEST_TIMEOUT。

deadlineAt 本身就是终态边界，不以 timer callback 实际获得调度的时刻为准。收到匹配 Response 时，Session 必须先比较当前单调时钟：

- now < deadlineAt：Response 可以正常 settle。
- now >= deadlineAt：先把 deliveryState 标记为 delivered，再以 REQUEST_TIMEOUT settle；即使 timeout timer 尚未执行，也不能接受该 Response。

超时后：

- 本地 Promise 以 REQUEST_TIMEOUT 拒绝。
- PendingMap 立即清理。
- Session 尽力取消尚在本地排队或重试的 Transport 操作。
- 如果 Request 已经到达远端，远端 Handler 继续正常执行。
- 迟到的 Response 被静默丢弃。

因此 REQUEST_TIMEOUT 不等价于“远端没有执行”。

## 12. Session 接收与 Handler 调度

Transport 完整解码 DATA 后，调用 Session 的同步入口：

~~~ts
interface TransportReceiver {
  accept(message: JsonValue): void;
  disconnected(error: TransportDisconnectedError): void;
  localClosed(): void;
  peerClosed(): void;
}
~~~

accept 必须轻量、同步返回，并且不把异常抛回 Transport。它只做：

- 最小结构校验；
- Request/Response 路由；
- Pending Response 匹配；
- Handler 的异步调度。

它不等待 Handler 完成。

localClosed 表示外部直接关闭了仍绑定 Session 的 Transport；peerClosed 表示对端通过 CLOSE 主动关闭。二者都让当前 Session/Client 进入永久关闭终态。普通链路故障只调用 disconnected，不关闭 Session。

### 12.1 收到 Request

1. 校验 type、requestId、method、payload。
2. 查找当前注册的 Handler。
3. 未注册该 method：静默丢弃，不发送 Response。
4. 已注册：捕获当前 Session peerEpoch，异步调度 Handler，然后 accept 返回。
5. 捕获 Handler 的任意结局：成功、抛错或结果不可序列化。
6. 在构造任何 Response 前统一检查 peerEpoch 未变化且 Session 仍开放；不满足时丢弃结果，不调用 Transport.send。
7. 条件满足时：成功结果发送成功 Response，抛错发送 HANDLER_ERROR，undefined 规范化为 null，其他不可序列化结果发送 RESPONSE_NOT_SERIALIZABLE。

Handler 不设并发上限，因此多个请求可以并发执行，Response 可以乱序返回。

Session 在每次 Transport disconnect、localClosed 或 peerClosed 时递增自己的 peerEpoch。旧连接启动的 Handler 仍可执行完，但如果完成时 epoch 已改变或 Session 已关闭，其 Response 必须丢弃并记录，不能通过新连接发给新的对端。这个 epoch 是 Session 内部的逻辑代次，不是 transferId，也不要求 Session 接触 WebSocket 对象。

成功 Response 和错误 Response 在发送前都必须执行相同的 peerEpoch/Session open 检查。

### 12.2 收到 Response

- PendingMap 中存在 requestId：按 ok 字段 resolve 或 reject。
- requestId 不存在：静默丢弃。
- 迟到、重复或未知 Response：静默丢弃。
- 不因为无效或未知 Session 报文关闭 Session。

### 12.3 Session 报文错误

以下情况全部静默丢弃，不响应、不关闭 Session：

- 不是合法 SessionMessage；
- type 未知；
- 字段类型错误；
- Response 找不到 Pending；
- Request method 未注册。

Transport 只关心报文已交给 Session，因此只要 accept 正常返回，即使 Session 决定丢弃，Transport 仍然发送 ACK。

## 13. Handler 错误

Session 使用以下远端错误码：

- HANDLER_ERROR：Handler 抛出异常。
- RESPONSE_NOT_SERIALIZABLE：Handler 结果不能编码为 JSON。

默认消息应该安全、稳定，例如“Remote handler failed”，不能直接采用未知异常对象的 message。

Session 在构造成功 Response 前先执行递归 JsonValue 校验；这一步属于 Handler 结果规范化。Transport 仍负责最终 wire 编码和再次防御性校验。

如果发送错误 Response 本身失败，例如队列已满或连接断开：

- 服务端记录结构化日志；
- 不再递归发送另一个错误；
- 请求端最终由自己的超时或断开逻辑结束。

## 14. Transport 逻辑接口

接口用于表达层间契约：

~~~ts
export interface TransportSendOptions {
  /**
   * 仅供 Session 内部使用；不属于公共 SDK 请求取消能力。
   */
  signal?: AbortSignal;
  /**
   * Session 的绝对端到端截止时间；Transport 不把它暴露为公共取消 API。
   */
  deadlineAt?: number;
  /**
   * 仅供 Session 维护 Pending 的交付阶段。
   */
  onDeliveryChange?: (
    delivery: "unknown" | "delivered",
  ) => void;
}

export interface Transport {
  bind(receiver: TransportReceiver): void;
  unbind(receiver: TransportReceiver): void;

  connect(): Promise<void>;

  send(
    message: SessionMessage,
    options?: TransportSendOptions,
  ): Promise<void>;

  close(): Promise<void>;
}
~~~

Transport.send 应始终返回 Promise。队列满、未连接、编码失败、deadline 已到等“立即失败”，表现为立即 rejected Promise，避免一部分错误同步 throw、另一部分异步 reject。内部 deadline 错误由 Session 映射为 REQUEST_TIMEOUT。

bind 只允许在当前没有 receiver 时安装一个 Session；重复绑定同一 receiver 可以幂等，绑定不同的 receiver 必须立即失败。unbind 只有在传入对象与当前 receiver 相同时才生效，因此旧 Session 的迟到 unbind 不能删除后来合法绑定的新 Session。

onDeliveryChange 只允许单向推进：

~~~text
not_sent
  → unknown    第一个 chunk 的 WebSocket.send 正常返回
  → delivered  当前 transfer 的全部 chunk 收到 Transport ACK
~~~

Transport 在发送第一个 chunk 前仍为 not_sent；WebSocket.send 同步抛错也保持 not_sent。任意 chunk 发送正常返回后，即使稍后断线也只能判断为 unknown。全部 chunk 收到匹配 ACK 时，Transport 必须先通知 delivered，再 resolve send。Session 收到匹配 Response 时也把该 Pending 视为 delivered，因为 Response 已证明 Request 到达并被远端 Session 处理。

## 15. Transport.send 的成功定义

Transport.send 只有在满足以下全部条件后才能 resolve：

1. 本端完成编码和准入。
2. 当前 transfer 的全部 DATA chunk 已通过 WebSocket 发出。
3. 对端 Transport 收到并重组全部 chunk。
4. 对端 Transport 完成完整 payload 解码。
5. 对端 Transport 同步调用 Session.accept。
6. Session.accept 正常返回。
7. 对端 Transport 确认完成重组的 chunk，并补发所需 ACK。
8. 本端收到匹配当前连接、当前 transferId 的全部 Chunk ACK。

它不等待：

- 对端 Handler 开始；
- 对端 Handler 完成；
- Response 返回。

TCP 会负责字节流的有序重传，但 TCP ACK 只表示对端协议栈接收了字节，不表示对端应用已读取，更不表示已经交给 Session。WebSocket.send 本地返回成功同样不满足上述定义，也没有提供“对端 Session 已接收”的回执，因此 V1 必须有自定义 Transport ACK。

## 16. 编码快照与准入

Transport.send 被调用时，必须立即：

1. 校验当前连接状态。
2. 递归校验 SessionMessage 确实是合法 JsonValue。
3. 用该 Transport 自己的 Codec 编码 Session JSON。
4. 生成完整的不可变 DATA 发送快照。
5. 计算最终 WebSocket DATA 文本帧的 UTF-8 字节数。
6. 重新检查 deadlineAt。
7. 检查固定上限。
8. 成功后才进入 FIFO。

因此调用方在 send 之后修改原对象，不会改变已经排队的内容。

每个具体 Transport 自己定义以下协议常量；Client/Session 不参与分片和窗口控制：

~~~ts
MAX_MESSAGE_BYTES
CHUNK_PAYLOAD_BYTES
MAX_CHUNKS_PER_TRANSFER
MAX_IN_FLIGHT_CHUNKS
MAX_QUEUED_MESSAGES
MAX_QUEUED_BYTES
ACK_TIMEOUT_MS
MAX_SEND_ATTEMPTS
CLOSE_ACK_TIMEOUT_MS
~~~

具体数值在实现前通过基准测试确定；在数值确定前，它们是 V1 唯一保留的实现参数空位。

MAX_MESSAGE_BYTES 以每个最终 WebSocket DATA 文本帧的 UTF-8 字节数为准，包含外层帧、转义和多字节字符。CHUNK_PAYLOAD_BYTES 以 DATA.payload 的 UTF-8 字节数为准；MAX_QUEUED_BYTES 累计一个 transfer 的所有最终 chunk 快照。

队列预算统计所有尚未进入终态的逻辑 transfer，包括当前窗口内等待 ACK 的 chunk 和等待发送的 chunk。ACK、CLOSE、CLOSE_ACK 不进入 DATA 队列；Transport 另以 MAX_IN_FLIGHT_CHUNKS 限制 active transfer 的并行 chunk 数。

超出限制时：

- 单条消息过大：MESSAGE_TOO_LARGE。
- 排队消息数或字节数已满：TRANSPORT_QUEUE_FULL。
- 编码失败：ENCODE_ERROR。

这些失败发生在入队前，确定没有把该消息发送给对端。

## 17. WebSocket V1 帧

### 17.1 统一 Chunk 语义

Transport 先把完整的 Session JSON payload 按 Unicode code point 切分为多个
UTF-8 chunk。默认每个 `DATA.payload` 不超过
`CHUNK_PAYLOAD_BYTES = 64 * 1024` 字节（64 KiB）。切分不会破坏代理对或
UTF-8 序列；重组后必须与原始 payload 保持一致。15,074 字节的 5000 汉字
`sendText` Session 报文会放在一个 chunk 中。

当前发送端始终遵守这个 64 KiB 分片上限。为兼容早期固定单帧发送端，接收端
对 `chunkCount === 1` 的 DATA 保留一个入站例外：其 `payload` 可以放宽到
`MAX_MESSAGE_BYTES`；该例外不会改变新发送端的分片行为，也不能用于多 chunk
transfer。

- `chunkCount` 为该 transfer 的总 chunk 数，至少为 1。
- `chunkIndex` 从 0 开始，必须小于 `chunkCount`。
- 一个 SessionMessage 对应一个 `transferId`，可以对应多个 DATA。
- 一个 transfer 的 chunk 数不能超过 `MAX_CHUNKS_PER_TRANSFER`。

### 17.2 逻辑帧

~~~ts
type TransportFrame =
  | {
      kind: "DATA";
      transferId: number;
      chunkIndex: number;
      chunkCount: number;
      payload: string;
    }
  | {
      kind: "ACK";
      transferId: number;
      chunkIndex: number;
    }
  | {
      kind: "CLOSE";
    }
  | {
      kind: "CLOSE_ACK";
    };
~~~

V1 WebSocket Codec 使用 UTF-8 JSON 文本：

1. 先对 SessionMessage 执行 JSON.stringify，得到完整 payload。
2. 按 CHUNK_PAYLOAD_BYTES 切分 payload。
3. 将每个片段放入带相同 transferId/chunkCount 的 DATA 逻辑帧。
4. 再对 TransportFrame 执行 JSON.stringify，作为 WebSocket 文本帧。

队列保存第 4 步的每个最终字符串及其 UTF-8 字节数。MAX_MESSAGE_BYTES 约束单个
chunk frame，MAX_QUEUED_BYTES 统计整个 transfer 的快照总和。重试必须复用完全
相同的最终字符串，不能重新读取或重新编码调用方对象。

双层 JSON 是 V1 的明确取舍：优先保证 Codec 边界、快照语义和多 Chunk 重组边界清晰；后续可在不改变 Session API 的前提下切换为二进制帧。

### 17.3 入站限制

接收端必须先按原始 WebSocket 文本帧的 UTF-8 字节数执行 MAX_MESSAGE_BYTES 检查，再解析 TransportFrame。多 chunk DATA 的每个片段不得超过 CHUNK_PAYLOAD_BYTES；`chunkCount === 1` 可按上一节的兼容例外放宽。DATA 片段先在 Transport 内按 transfer 重组；完整 payload 必须能解析为合法 JsonValue，随后 Transport 才调用 Session.accept，由 Session 检查 SessionMessage 结构。可解析但不是合法 SessionMessage 的 JSON 仍会被交给 Session，并在 accept 正常返回后确认最后一个 chunk。

超限、无法解析或不符合 TransportFrame 结构的入站帧：

- 丢弃；
- 不交给 Session；
- 不发送 ACK；
- 记录诊断日志；
- V1 默认不因此关闭连接。

## 18. transferId 与连接代次

### 18.1 transferId

- transferId 由 Transport 生成。
- 每个新 connection generation 的第一个 transferId 为 1；接收端 high-water 初始为 0。
- 每个发送方向独立递增。
- 只在当前 WebSocket 连接代次内有效。
- 新连接重新从初始值开始。
- 与 requestId 完全独立。
- 线上 transferId 必须是 1 到 Number.MAX_SAFE_INTEGER 之间的安全整数。
- 不能回绕复用；达到 Number.MAX_SAFE_INTEGER 前重建连接。
- transferId 在构造不可变 DATA 快照前分配，之后即使准入失败或内部取消也不复用，因此连接内出现空洞是合法的。

### 18.2 connection generation

Transport 内部维护递增的 connection generation。它不需要出现在 V1 线上帧中，因为不同 WebSocket 本身已经隔离连接。

所有 WebSocket 回调、ACK timer 和 close timer 都捕获创建它们时的 generation。回调执行时 generation 不匹配，就直接忽略。

这防止旧 WebSocket 迟到的 open、message、close 或 ACK 污染新连接。

## 19. FIFO 与 Chunk 窗口

逻辑 transfer 使用严格消息级 FIFO；单个 transfer 内默认允许最多
`MAX_IN_FLIGHT_CHUNKS` 个 chunk 同时等待 ACK。`chunkWindowSize` 可以为链路或测试
覆盖这个默认值，但仍受 `MAX_CHUNKS_PER_TRANSFER` 约束：

~~~text
A 入队 → B 入队 → C 入队

发送 A
  ├─ A 成功 → 发送 B
  └─ A 失败 → A reject，然后仍发送 B

发送 B
  ├─ B 成功 → 发送 C
  └─ B 失败 → B reject，然后仍发送 C
~~~

规则：

- 同一时间只有队首逻辑 transfer 处于发送/等待 ACK 状态。
- 队首 transfer 内，窗口初始发送最多 MAX_IN_FLIGHT_CHUNKS 个 chunk；每收到一个匹配 ACK，补发一个新的 chunk。
- 一条逻辑消息的全部 chunk 到达成功、失败或内部取消终态后，才调度下一条消息。
- 下一次 FIFO pump 必须通过 microtask 异步调度，不能在 resolve、reject 或 Abort 的同一调用栈里直接发送下一条。
- A 因 ACK 重试耗尽而失败，不连带失败 B、C；只要 WebSocket 仍连接，就继续发送。
- 如果 WebSocket 实际断开，当前消息和全部排队消息都失败。
- Request 和 Response 共用同一个 FIFO；窗口只在单个 transfer 内生效。
- V1 不给 Response 更高优先级。
- ACK、CLOSE、CLOSE_ACK 是控制帧，绕过 DATA FIFO，避免死锁。

## 20. ACK、重试与去重

### 20.1 发送端

对当前 transfer 的每个 chunk：

1. 检查 signal 和 deadlineAt；已取消或过期则不发送。
2. 发送该 chunk 的最终编码快照，并启动 ACK_TIMEOUT_MS。
3. 收到匹配当前 generation、transferId 和 chunkIndex 的 ACK：清理该 chunk timer，释放一个窗口槽位。
4. 收到不匹配的 ACK 或当前没有对应 in-flight chunk：静默忽略。
5. 超时：如果尚有尝试次数，重新检查 signal/deadlineAt，再发送完全相同的 chunk 快照并重新计时。
6. 任意 chunk 达到 MAX_SEND_ATTEMPTS：整个 transfer 以 DELIVERY_UNCONFIRMED reject，然后调度下一条消息。
7. 只有全部 chunk ACK 收齐后，才将 Transport.send resolve，并推进到下一条消息。

MAX_SEND_ATTEMPTS 包含第一次发送。

### 20.2 接收端

收到 DATA：

1. 校验帧和 Chunk 字段，并限制单 chunk 和 transfer 总大小。
2. 将片段放入当前 transfer 的重组表；同 index 同内容的重复片段不重复存储。
3. 尚未完成重组时，已可靠缓存的非最后 chunk 可以立即 ACK，以推进发送窗口；最后 chunk 暂不 ACK。
4. 所有 chunk 齐全后按 index 拼接 payload，解析并同步调用 Session.accept。
5. accept 正常返回后记录当前 transfer 的逐 chunk 内容，并 ACK 本次完成重组的 chunk 与此前保留的末 chunk；更早丢失的 ACK 在对应 chunk 重传时补回。
6. 后续命中已完成 transfer 的重复 chunk 只重发对应 ACK，不再次交给 Session。

“先完整重组并交上层、后确认最后 chunk”保证 Transport.send 的最终 resolve 仍表示完整报文已交给 Session。

### 20.3 ACK 丢失

~~~text
发送端                         接收端
  │ DATA transferId=7 chunk=2    │
  ├──────────────────────────────►│
  │                               │ Session.accept（只执行一次）
  │         ACK 7/2 丢失          │
  │◄───────────────x──────────────┤
  │ timeout                       │
  │ DATA 7/2（相同字节）          │
  ├──────────────────────────────►│
  │                               │ 命中去重，不再 accept
  │             ACK 7/2           │
  │◄──────────────────────────────┤
  │ send resolve                  │
~~~

### 20.4 去重记录

同一方向只有一个 active transfer，transfer 内允许窗口化发送 chunk。接收端维护当前 partial transfer，以及最后一个已完成 transfer 的逐 chunk 内容：

- transferId 大于 highest：建立或继续 partial transfer；全部 chunk 齐全且 accept 成功后推进 highest。
- transferId 等于已完成 transfer、chunk 内容相同：不得再次交给 Session，立即重发对应 ACK。
- 同 transferId、同 index 内容不同或 chunkCount 冲突：协议违规；丢弃、不 ACK，并记录诊断。
- transferId 小于 highest：这是已经终止的旧 transfer；丢弃且不 ACK。

发送端一旦开始更高 transferId，就不会再合法重试更低 ID；接收端只保留一个 partial transfer 和最后一个 completed transfer，避免去重内存随长连接无限增长。

## 21. 内部取消

V1 不支持 SDK 使用者主动取消，但 Session 可以通过内部 signal 停止已无意义的 Transport 工作：

- 仍在队列中：移除并拒绝内部 send。
- 正在等待 ACK：停止后续重试并释放 FIFO。
- 已经交给对端：无法撤销，对端仍可处理。
- 已经 resolve/reject：取消无效果。

触发内部取消的情况包括：

- 请求超时；
- Response 已先到；
- Session close；
- 其他终态已经获胜。

Transport 内部的取消错误不作为公共 SDK 错误暴露；Session 已经用真正的请求终态完成 Promise。

## 22. 断线与重连

### 22.1 非主动断线

WebSocket 意外断开时，Transport：

1. 标记当前 generation 已失效。
2. 清理 ACK 和 close timers。
3. 同步拒绝当前 DATA，delivery 为 unknown。
4. 同步拒绝尚未发送的排队 DATA，delivery 为 not_sent。
5. 清空本连接的去重状态。
6. 在上述 Promise rejection 已排入 microtask 队列后，同步通知 Session disconnected。

Session：

- 在 disconnected 回调中立即递增 peerEpoch，使旧 Handler 不能向未来连接发送 Response。
- 把“拒绝剩余 Pending”排入 microtask，而不是在回调中同步执行。Transport send 的 rejection reaction 因为先入队，会先用每个发送项的精确 delivery 完成对应请求。
- 随后的批量清理只拒绝尚未 settle 的 Pending；这些请求通常已经收到 Transport ACK、正在等待业务 Response，使用 TRANSPORT_DISCONNECTED、delivery: delivered。
- 不重发任何 Request。
- 保留 Handler 注册和自身 requestId 计数器。
- 保持可在 Transport 重连后处理新请求。

重连后：

- 新建 WebSocket；
- connection generation 递增；
- transferId 和去重记录重置；
- 旧队列、旧 active send 和旧 Pending 不恢复；
- Session requestId 不重置；
- 旧连接迟到事件被 generation 检查丢弃。
- 旧连接启动但尚未完成的 Handler 可以继续运行，结果因 peerEpoch 不匹配而被丢弃。

### 22.2 交付语义

断线发生时：

- 尚未从队列发出的消息：确定没有交付。
- 已发出但未收到 ACK 的消息：是否交付未知。
- 已收到 Transport ACK、但仍在等待 Response 的请求：Request 已到达对端 Session，但业务是否完成或 Response 是否返回未知。

上层若决定重试，必须接受重复业务执行的可能性，或在业务 payload 中自行携带幂等键。Session 不替业务做幂等。

### 22.3 重连身份

V1 只规定本地 Transport/Session 的生命周期。新 WebSocket 在服务端如何恢复为同一个逻辑用户、如何重新安装 Handler 或恢复未来的订阅，交由服务端连接管理与认证层定义。

## 23. 显式关闭

### 23.1 级联关闭

~~~text
client.close()
  → Client 清理并标记永久关闭
  → session.close()
      → 同步标记 closed、解绑 receiver、拒绝 Pending、清 timer
      → 在同一调用栈、任何 await 之前调用 transport.close()
          → 拒绝 DATA、发 CLOSE、等待 CLOSE_ACK
          → 关闭 WebSocket、清理全部资源
~~~

每一层先清理自己，再关闭下一层。

Session 批量 settle 时对 active send 的 Abort 可能释放 FIFO，因此上述“同一调用栈内调用 transport.close”与异步 pump 是强制配套规则：Transport.close 必须在返回 Promise 前同步进入 closing 并冻结 DATA FIFO；已经排入 microtask 的 pump 看到 closing 后直接退出。这样 A active、B queued 时关闭不会误发 B。

应用正常关闭入口是 client.close。Transport.close 仍是公开的连接层操作，并且必须在被外部直接调用时保持安全：

- 如果 receiver 仍绑定，Transport 先拒绝 active/queued DATA，再调用 localClosed。
- Session/Client 按终态关闭清理 Pending、Handler、timer 和绑定，但不递归调用 transport.close，因为关闭已经在进行。
- 如果调用来自 session.close，Session 已先 unbind，因此 Transport 不再回调 localClosed。

### 23.2 Transport close 握手

CLOSE/CLOSE_ACK 是 V1 明确采用的自定义 Transport 控制协议，不只依赖 WebSocket 自带的 close frame。

CLOSE 和 CLOSE_ACK 绕过 DATA FIFO：

1. 本端进入 closing。
2. 立即拒绝 active 和 queued DATA，不等待排空。
3. 发送 CLOSE。
4. 等待 CLOSE_ACK，最长 CLOSE_ACK_TIMEOUT_MS。
5. 收到 ACK 或超时后关闭底层 WebSocket 并完成本地清理。

收到 CLOSE 时先立即发送 CLOSE_ACK，然后按本地状态分支：

- 本地尚未 closing：使当前 connection generation 失效，拒绝 active/queued DATA，通知上层 peerClosed，执行终态清理并关闭 WebSocket。
- 本地已经 closing：这是同时关闭或重复 CLOSE。不得提前使本地 generation 失效，也不重启 close timer；继续等待自己的 CLOSE_ACK 或现有 CLOSE_ACK_TIMEOUT_MS。收到自己的 ACK 或 timer 到期时再完成关闭并使 generation 失效。

localClosed 和 peerClosed 对 Session/Client 都是终态，而不是可透明重连的普通断线。共同规则是：

- Session 立即递增 peerEpoch 并标记永久 closed。
- Session 在逐发送项 rejection reaction 之后拒绝其余 Pending，清理 timers、Handler 注册和 receiver 绑定。
- 逐发送项的底层 close rejection 由 Session 统一映射为 SESSION_CLOSED，同时保留各自的 deliveryState。
- 已经运行的 Handler 可以结束，但结果被丢弃，不发送 Response。
- Session 不再次调用 transport.close 或发起第二轮 CLOSE；正在处理 CLOSE 的 Transport 负责关闭链路。
- Client 随 Session 进入永久不可用状态，后续调用以 SESSION_CLOSED 失败。

同时 close 时，双方都应 ACK 对方的 CLOSE，并保持各自原有 close timer 有效，最终各自完成关闭。重复 CLOSE、CLOSE_ACK 和 close 调用必须幂等。

如果链路已断，close 不等待握手，直接完成本地清理。

### 23.3 关闭后的复用

- 旧 Client 和旧 Session 永久不可用，后续调用以 SESSION_CLOSED 失败。
- V1 WebSocketTransport 在完整 close/reset 后允许复用。
- 复用顺序是先创建并绑定新 Client/Session，再调用同一个 WebSocketTransport 的 connect。
- 任何旧 Client 回调都不能影响新绑定。

## 24. 错误模型

所有公共错误都继承同一个 SDKError，并至少包含：

~~~ts
interface SDKErrorShape {
  code: string;
  message: string;
  delivery: "not_sent" | "unknown" | "delivered";
  cause?: unknown;
}
~~~

cause 只保留在本地，不上线传输。

Pending 精确跟踪 not_sent → unknown → delivered 的单向阶段。delivery 是错误 settle 时的阶段，不由错误码单独决定；其中 unknown 是一个精确类别，表示已经尝试发送但没有交付确认。delivered 只表示 Request 已交给远端 Session，不单独保证业务成功。下表列的是固定值或可能值：

| code | 产生层 | delivery（固定或可能值） | 含义 |
| --- | --- | --- | --- |
| REQUEST_TIMEOUT | Session | not_sent / unknown / delivered | 截止时按 Pending 当前阶段填写；远端可能已经执行 |
| TRANSPORT_QUEUE_FULL | Transport | not_sent | 编码后队列准入失败 |
| TRANSPORT_NOT_CONNECTED | Transport | not_sent | 调用 send 时没有可用连接 |
| MESSAGE_TOO_LARGE | Transport | not_sent | 编码后消息超过固定限制 |
| ENCODE_ERROR | Transport | not_sent | Session JSON 无法编码 |
| DELIVERY_UNCONFIRMED | Transport | unknown | DATA 多次尝试后仍未收到 Transport ACK |
| TRANSPORT_DISCONNECTED | Transport/Session | not_sent / unknown / delivered | queued 为 not_sent；active 为 unknown；已 ACK、等 Response 为 delivered |
| SESSION_CLOSED | Session | not_sent / unknown / delivered | 关闭后新调用为 not_sent；等待中的请求按 Pending 阶段决定 |
| REMOTE_ERROR | Session | delivered | 收到对端 Handler 的错误 Response |

补充规则：

- Transport 对每个发送项保留实际 delivery；断线时队列中尚未发送的项应返回 not_sent。
- Session Pending 通过 onDeliveryChange 保存阶段；Timeout、Disconnect 和 Close 都使用 settle 时的阶段。
- Session 已收到 Response 时，不再让迟到的 Transport 错误覆盖成功或 REMOTE_ERROR。
- “unknown”明确表示上层重试可能导致重复执行。
- 错误码稳定，message 用于人读，不用于程序分支。

## 25. 完整请求时序

~~~text
发起端 Client       发起端 Session      发起端 Transport     对端 Transport       对端 Session
     │ request()           │                    │                    │                    │
     ├────────────────────►│                    │                    │                    │
     │                     │ pendingMap.set     │                    │                    │
     │                     │ transport.send     │                    │                    │
     │                     ├───────────────────►│                    │                    │
     │                     │                    │ DATA               │                    │
     │                     │                    ├───────────────────►│                    │
     │                     │                    │                    │ accept(request)    │
     │                     │                    │                    ├───────────────────►│
     │                     │                    │                    │◄───────────────────┤ 同步返回
     │                     │                    │ ACK                │                    │
     │                     │                    │◄───────────────────┤                    │
     │                     │ send resolve       │                    │                    │
     │                     │                    │                    │       Handler 异步执行
     │                     │                    │                    │◄───────────────────┤ response send
     │                     │                    │◄───────────────────┤ DATA(response)      │
     │                     │ accept(response)   │                    │                    │
     │                     │◄───────────────────┤                    │                    │
     │ Promise resolve     │                    │ ACK                │                    │
     │◄────────────────────┤                    ├───────────────────►│                    │
~~~

Response 使用与 Request 完全相同的 Transport DATA/ACK 机制。

## 26. 必须保持的协议不变量

实现和测试必须共同保证：

1. 一个 Session 请求最多 settle 一次。
2. Pending 在调用 Transport.send 前已经存在。
3. settle 先清 Map/timer，再调用用户回调。
4. 中间 chunk ACK 只表示该片段已可靠缓存；最后一个未确认 chunk 只有在完整报文已同步交给 Session 后才 ACK。
5. 同一 connection generation、同一 transferId 最多向 Session 交付一次。
6. transferId 等于当前 completed transfer 且对应 chunk 内容相同的重复 DATA 必须重发 ACK；低 ID 或摘要冲突不 ACK。
7. DATA chunk 重试复用同一个 transferId、chunkIndex 和完全相同的编码字节。
8. 逻辑 transfer 严格 FIFO，chunk 受窗口限制；一条失败不阻塞后续消息。
9. 链路断开会失败当前和全部排队 DATA，不跨连接恢复。
10. Session 不自动重发请求。
11. 端到端超时从 request 调用时开始。
12. Request 与 Response 共用 FIFO，Response 可乱序到达 Session。
13. 控制帧绕过 DATA FIFO。
14. 旧 connection generation 的事件不能影响新连接。
15. client.close 后旧 Client/Session 永久不可用。
16. 所有出站 SessionMessage 在 JSON.stringify 前通过递归 JsonValue 校验。
17. deadlineAt 在编码后、入队前、每次发送和重试前检查。
18. 断线时逐发送项 rejection 先于 Session 的剩余 Pending 批量清理生效。
19. 旧 peerEpoch 启动的 Handler 不得向新连接发送 Response。
20. peer CLOSE 使对端旧 Session/Client 进入永久关闭终态。
21. deadlineAt 时刻及之后到达的 Response 不能成功，即使 timeout timer 尚未执行。
22. Pending delivery 只能按 not_sent → unknown → delivered 单向推进。

## 27. 测试矩阵

所有定时测试使用 fake clock。Fake WebSocket Link 必须支持丢弃、延迟、重复 DATA/ACK/CLOSE，并能注入旧 connection generation 的迟到事件。

每个测试除功能断言外，还要检查：

- Promise 只 settle 一次；
- timer、PendingMap、队列和监听器被清理；
- 没有 unhandled rejection；
- 不发生重复 Handler 调用。

### 27.1 Transport 单元测试

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| TR-01 | send 后修改原对象 | 对端收到编码时的快照 |
| TR-02 | 5000 个汉字传输 | 完整 Session JSON 为 15,074 bytes，使用 1 个 64 KiB chunk，只 accept 一次 |
| TR-03 | Chunk 边界（含中文、emoji、引号转义） | 每段 payload <= 64 KiB，不切断码点；完整 payload 超限 MESSAGE_TOO_LARGE |
| TR-04 | 队列条数/字节边界 | 按逻辑 transfer 计数，多 chunk transfer 仍只占一条；满时立即 TRANSPORT_QUEUE_FULL |
| TR-05 | 未连接 send | TRANSPORT_NOT_CONNECTED，且不入队 |
| TR-06 | 正常 DATA/ACK | 完整重组并 accept、全部 chunk ACK 后 send resolve |
| TR-07 | ACK 先于 accept 的错误实现 | 测试应能捕获，规范实现不得发生 |
| TR-08 | 中间 Chunk ACK 丢失 | 只以相同字节重试对应 chunk，对端只 accept 一次 |
| TR-09 | completed transfer 的同内容重复 chunk | 不重复 accept，并再次 ACK |
| TR-10 | 旧连接、错误 ID、无对应 in-flight chunk 时的 ACK | 全部忽略，不改变窗口/FIFO |
| TR-11 | 重试耗尽 | A 为 DELIVERY_UNCONFIRMED |
| TR-12 | Chunk window | 初始最多发送窗口大小；每个 ACK 只补一个槽位 |
| TR-13 | 多条正常消息 | 严格 A、B、C FIFO |
| TR-14 | 控制帧与满 DATA 队列 | ACK/CLOSE 不被 DATA 队列阻塞 |
| TR-15 | 内部 signal 取消排队项 | 移除该项并继续后续项 |
| TR-16 | 内部 signal 取消 active | 停止重试并继续后续项 |
| TR-17 | WebSocket 断开 | active 未知、queued 未发送，全部拒绝 |
| TR-18 | 断线后重连 | 不恢复旧发送；新发送使用新 generation |
| TR-19 | 旧 WebSocket 迟到回调 | 不污染新连接 |
| TR-20 | 正常 CLOSE/CLOSE_ACK | 绕过队列并完成清理 |
| TR-21 | CLOSE_ACK 丢失 | 固定超时后仍完成本地关闭 |
| TR-22 | 同时/重复 close | closing generation 与原 timer 保持有效；幂等、无死锁、无重复通知 |
| TR-23 | completed chunk 重复、空洞低 ID、同 index 不同内容 | 相同 completed chunk 重 ACK；低 ID 或冲突内容不交付、不 ACK |
| TR-24 | 外层 TransportFrame 非法、重组 payload 非法或原始帧超限 | 丢弃、不 ACK、不关闭连接 |
| TR-25 | 嵌套 undefined/function/symbol/NaN/±Infinity | 编码前拒绝，ENCODE_ERROR、not_sent |
| TR-26 | 编码过程跨过 Session deadline | 不入队、不发送，由 Session 映射 REQUEST_TIMEOUT |
| TR-27 | ACK 重试前跨过 Session deadline | 不再重试，释放 FIFO |
| TR-28 | transferId 接近 MAX_SAFE_INTEGER | 不回绕；要求重建连接 |
| TR-29 | 重复 bind、旧 receiver 迟到 unbind | 不同 receiver 的重 bind 失败；旧 unbind 不删除后来合法绑定的新 receiver |
| TR-30 | 无 receiver 时收到 DATA，随后绑定 | 首帧丢弃且不 ACK；下一次合法 retry 可交付 |
| TR-31 | 完整 close/reset 后复用 Transport | receiver、generation、ID、high-water、timer 与旧回调全部隔离 |

### 27.2 Session 单元测试

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| SE-01 | Transport.send 内同步触发 Response | Pending 已存在，能够正确匹配 |
| SE-02 | 正常 Response | resolve 并清 Pending/timer |
| SE-03 | Transport ACK、无 Response | 继续等待，最终 REQUEST_TIMEOUT |
| SE-04 | 远端错误 Response | REMOTE_ERROR |
| SE-05 | Queue full / not connected / encode failure | 立即拒绝，不等请求超时 |
| SE-06 | DELIVERY_UNCONFIRMED | 立即以交付未知错误拒绝 |
| SE-07 | 端到端计时 | 排队时间包含在 timeout 内 |
| SE-08 | Timeout 后迟到 Response | 静默丢弃 |
| SE-09 | Timeout 后远端 Handler | 继续执行，不受本地取消影响 |
| SE-10 | Disconnect | 所有 Pending 拒绝并清理 |
| SE-11 | Reconnect | Handler 保留，requestId 继续递增 |
| SE-12 | 双向请求 | 两端 requestId 可相同且不冲突 |
| SE-13 | 并发 Handler | 可乱序 Response，按 requestId 匹配 |
| SE-14 | Handler 替换 | 新请求使用后注册 Handler |
| SE-15 | 旧 unregister | 不删除替换后的新 Handler |
| SE-16 | 未知 method | 静默丢弃，调用方超时 |
| SE-17 | 合法 JSON、但不是合法 SessionMessage | Session 静默丢弃且保持开放；accept 返回后 Transport 仍 ACK |
| SE-18 | 未知/重复 Response | 静默丢弃 |
| SE-19 | Handler 抛错 | 发送安全 HANDLER_ERROR |
| SE-20 | Handler 返回 undefined | Response data 为 null |
| SE-21 | Handler 返回 bigint/循环对象/嵌套非法 JSON 值 | RESPONSE_NOT_SERIALIZABLE |
| SE-22 | 错误 Response 也发送失败 | 只记录，不递归；请求方超时 |
| SE-23 | Response 队列满 | 服务端发送失败；请求方超时 |
| SE-24 | session.close | Pending 全拒绝，后续请求 SESSION_CLOSED |
| SE-25 | peerClosed | Pending 拒绝、Handler/绑定清理，旧 Session 永久关闭且不反向 close |
| SE-26 | 旧连接 Handler 在重连后完成 | Handler 可完成，但 Response 因 peerEpoch 改变而丢弃 |
| SE-27 | requestId 接近 MAX_SAFE_INTEGER | 不回绕；要求新 Session |
| SE-28 | Session close 时 Handler 正在执行 | 结果丢弃，不调用 Transport.send，无 unhandled rejection |
| SE-29 | Timeout 的三个交付阶段 | 分别得到 REQUEST_TIMEOUT + not_sent / unknown / delivered |
| SE-30 | 外部直接 transport.close | localClosed 使 Pending/Handler/绑定清理，旧 Session 永久关闭且不递归 close |
| SE-31 | A active、B queued 时 session.close | B 不得在关闭调用栈与 Transport closing 之间被发送 |

### 27.3 竞态测试

至少覆盖：

- Response 先于 Transport ACK。
- Response 已到，但所有 ACK 都丢失。
- Transport 失败后 Response 到达。
- Response 与 Timeout 竞争。
- Response 与 Disconnect 竞争。
- Response 与 close 竞争。
- ACK 与 ACK timer 竞争。
- Session deadline 与 Transport FIFO 调度竞争。
- close 后收到旧 DATA、ACK、Response 和 WebSocket 回调。

Response/Timeout 还必须覆盖 timer callback 被事件循环延迟的情况：deadline 前到达的 Response 可以成功；deadlineAt 时刻及之后到达的 Response 必须 REQUEST_TIMEOUT，即使 Response callback 先于 timer callback 执行。

每组其他竞态都分别构造两种确定事件顺序，不能依赖 fake clock 对同一时间任务的偶然排序；每个用例都验证“第一个有效终态获胜”。

### 27.4 Client 单元测试

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| CL-01 | sendText("hello") | 映射为 method: sendText、payload: { text: "hello" } |
| CL-02 | 未配置 requestTimeoutMs | 向 Session 传递 DEFAULT_REQUEST_TIMEOUT_MS |
| CL-03 | 配置 requestTimeoutMs | 覆盖默认值并作为统一端到端 timeout |
| CL-04 | Session/Transport 错误 | 保留错误 code 与 delivery，不吞错或自动重试 |
| CL-05 | client.close | 按 Client → Session → Transport 级联 |
| CL-06 | close 后调用 | SESSION_CLOSED、not_sent |
| CL-07 | 复用已 reset Transport 创建新 Client | 新 Client 可连接；旧 Client 回调无效 |
| CL-08 | requestTimeoutMs 为 0、负数、NaN 或 Infinity | Client 构造立即失败 |

### 27.5 集成测试

至少覆盖：

- 两端正常 Request/Response。
- 两端同时主动请求。
- 多并发请求与乱序 Response。
- 丢 DATA、丢 ACK、重复 DATA。
- 全部 ACK 丢失。
- Request 已处理但 ACK 丢失。
- Response DATA 的 ACK 丢失：请求方只 settle 一次并对重复 Response DATA 重 ACK；全部 Response ACK 丢失也不覆盖请求方已获得的结果。
- 在编码、排队、发送、Handler、Response 排队、Response 发送各阶段断线。
- 排队耗尽端到端超时。
- 请求方超时时，远端 Handler 仍正常完成。
- Request 和 Response 共用 FIFO 时的双向压力。
- A 失败、B/C 继续。
- 短暂断线、Transport 重连、旧 Pending 不恢复、新请求成功。
- 断线时 active 请求为 unknown、queued 请求为 not_sent、已 ACK 等 Response 的请求为 delivered。
- 旧连接 Handler 完成后不向新连接发送 Response。
- 显式 close 后旧 Client 失败，新 Client 成功。
- 收到 peer CLOSE 后，对端旧 Client/Session 永久关闭。
- 外部直接 transport.close 时，本地旧 Client/Session 也立即进入永久关闭终态。
- 正常 close 握手、CLOSE 丢失、CLOSE_ACK 丢失和同时 close。

## 28. 实现顺序

建议按以下顺序推进：

1. 在 @remote-input/protocol 中定义 JsonValue、SessionMessage、错误类型和 Transport 接口。
2. 实现 Fake Link、Fake Clock 和确定性 Transport 测试夹具。
3. 实现 WebSocket Codec、DATA/ACK、FIFO、重试、去重、generation 和 close。
4. 实现 Session PendingMap、唯一 settle、端到端 timeout、双向 Handler。
5. 在 @remote-input/sdk 中实现 Client 和 sendText 等薄封装。
6. 完成双端集成测试和故障注入测试。
7. 接入现有应用，删除或隔离旧 Socket.IO 协议残留。

每一步先通过包内 test/check，再由根目录 turbo 任务统一验证。

## 29. V2 / TODO

V1 完成后再评估：

- notify/topic/多 consumer 订阅。
- 本地立即取消订阅、后台控制报文。
- 通知不可靠、不重放的具体语义。
- HTTP Transport。
- 蓝牙 Transport 和不同链路上的分片编码适配。
- 更复杂的拥塞控制和跨 transfer 并行窗口。
- Handler 并发上限。
- PendingMap 上限。
- Response 优先级或独立队列。
- 用户主动取消和单请求 timeout。
- 跨连接恢复、重放或业务幂等支持。
- 协议版本与能力协商。
- 认证、授权、限流、加密和压缩。
- 生产级指标、分布式 Tracing、日志持久化和诊断采样。

## 30. V1 实现常量

V1 的初始实现基线使用以下固定值：

| 常量 | 数值 | 含义 |
| --- | ---: | --- |
| DEFAULT_REQUEST_TIMEOUT_MS | 30,000 ms | SDK/Session 默认端到端请求超时 |
| CHUNK_PAYLOAD_BYTES | 64 KiB | 新发送端每个 DATA.payload 的 UTF-8 上限；单 chunk 入站兼容例外见 17.1 |
| MAX_CHUNKS_PER_TRANSFER | 5 | 单个重组 transfer 的保守 chunk 数上限；覆盖 UTF-8 码点边界最多浪费 3 字节的情况 |
| MAX_IN_FLIGHT_CHUNKS | 4（默认） | active transfer 同时等待 ACK 的默认 chunk 数；可用 `chunkWindowSize` 覆盖 |
| MAX_MESSAGE_BYTES | 256 KiB | 单个编码后 WebSocket DATA 帧及完整 payload 的 UTF-8 上限 |
| MAX_QUEUED_MESSAGES | 128 | 每个 Transport 连接允许排队的逻辑 transfer 数量上限 |
| MAX_QUEUED_BYTES | 4 MiB | active 与 queued DATA 编码快照的总字节上限 |
| ACK_TIMEOUT_MS | 2,000 ms | 每次 DATA 发送后等待 Transport ACK 的时间 |
| MAX_SEND_ATTEMPTS | 3 | 同一 DATA 的最大发送次数（包含首次发送） |
| CLOSE_ACK_TIMEOUT_MS | 2,000 ms | 主动关闭时等待 CLOSE_ACK 的固定时间 |
| DEFAULT_WEBSOCKET_PATH | /ws | 应用默认 WebSocket 接入路径 |

调用者只能在 `new Client` 时通过 `requestTimeoutMs` 覆盖默认端到端超时；
`WebSocketTransport` 可通过 `chunkWindowSize` 在测试或链路适配时覆盖并行窗口，
其默认值仍由 `MAX_IN_FLIGHT_CHUNKS` 提供。其他容量、重试和关闭常量若依据压测
调整，应同步更新实现、测试与本文档。

## 31. 开发流程追踪

`ProtocolRuntimeOptions` 提供独立于 `onDiagnostic` 的结构化开发追踪：

~~~ts
type ProtocolTraceLevel = "summary" | "chunks";

type ProtocolTraceEvent = {
  at: number;
  layer: "transport" | "session";
  event: string;
  details: Readonly<Record<string, string | number | boolean | null>>;
};

type ProtocolRuntimeOptions = {
  onTrace?: (event: ProtocolTraceEvent) => void | PromiseLike<void>;
  traceLevel?: ProtocolTraceLevel;
};
~~~

- `summary`：记录 Pending、transfer 入队/重组/完成、Session accept、Handler、Response 和结算。
- `chunks`：在 summary 基础上记录每个 chunk 的发送尝试、缓存、ACK 和窗口推进。
- 未提供 `onTrace` 时不产生追踪事件；应用的两个环境开关默认关闭。
- 追踪事件通过微任务异步投递；回调同步抛错或返回 rejected Promise 都不会影响协议状态。
- 事件不包含 Session payload、DATA snapshot、输入正文或 Handler 返回数据。

仓库开发环境可同时打开双端 summary：

~~~bash
INPUT_MODE=dev PROTOCOL_DEBUG=summary VITE_PROTOCOL_DEBUG=summary pnpm dev
~~~

检查超过 64 KiB 的多 chunk 报文时将两项改为 `chunks`。Server 日志输出到终端，
Client 日志输出到浏览器开发者控制台；`createConsoleProtocolTracer(label)` 会加入
端点标签与单调日志序号。控制台输出使用中文说明，内部从 0 开始的 `chunkIndex`
显示为从 1 开始的 `1/N` 编号；稳定事件码仍保留在方括号中，便于过滤：

~~~text
[协议][客户端/运行-1][传输层][chunk.send] 尝试发送 chunk 1/3：传输ID=1，第1次尝试
[协议][服务端/连接-1][传输层][chunk.received] 收到 chunk 1/3：传输ID=1，内容=65536B
[协议][服务端/连接-1][传输层][ack.send] 尝试发送 chunk 1/3 的 ACK：传输ID=1
[协议][客户端/运行-1][传输层][chunk.ack.received] 收到 chunk 1/3 的 ACK：传输ID=1，已确认=1/3
~~~

`chunk.send` 与 `ack.send` 在底层 `WebSocket.send()` 调用前记录，因此准确含义是
“尝试发送”；只有 `chunk.ack.received` 能证明发送端已经收到了对应 ACK。
