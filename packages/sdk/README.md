# @remote-copy/sdk

`@remote-copy/sdk` 是 Remote Copy 面向应用的轻量 SDK。它只提供 Socket.IO 连接、远程输入、状态缓存和通知订阅。协议契约位于 `@remote-copy/protocol`，标准运行时位于 `@remote-copy/protocol/implementations`。

架构和协议设计见：

- [远程输入模块目标架构](../../docs/architecture.md)
- [协议包定义与实现](../protocol/README.md)
- [Socket.IO 协议与 SDK 重构实施计划](../../docs/implementation-plan.md)

## 快速开始

```ts
import { RemoteInputClient } from "@remote-copy/sdk";

const client = new RemoteInputClient({
  clientName: "网页浏览器",
});

client.subscribe((state) => {
  console.log(state.connectionState, state.currentOperation);
});

client.subscribeNotification((notification) => {
  console.log(notification.name, notification.body);
});

await client.connect("http://127.0.0.1:17888");
const { operationId } = await client.sendInput("你好，Remote Copy");
console.log("下游已接受：", operationId);
```

`sendInput()` resolve 表示 Server 已接受 operation，不表示输入已经执行完成。最终状态通过 `operation.status` Notification 更新。

## API

```ts
class RemoteInputClient {
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;

  sendInput(text: string): Promise<{ operationId: string }>;

  getState(): RemoteInputState;
  subscribe(listener: RemoteInputStateListener): () => void;

  getOperationStatus(operationId: string): OperationStatus | null;
  refreshOperationStatus(operationId: string): Promise<OperationStatus>;
  subscribeOperation(operationId: string, listener: OperationStatusListener): () => void;

  subscribeNotification(listener: ProtocolNotificationListener): () => void;
}
```

普通调用方只需传入 Socket.IO Server 的 HTTP(S) origin。SDK 第一版关闭 Socket.IO 自动重连；重连应显式再次调用 `connect(url)`。

## 状态语义

operation state：

```text
accepted -> processing -> succeeded
     |           |
     +-----------+-----> failed
```

- `accepted`：下游已接受 operation。
- `processing`：下游正在执行。
- `succeeded`：当前协议下游完成自身职责。
- `failed`：当前协议下游执行失败。

每次状态更新携带递增 `revision`，SDK 只接受更新版本。

## 分层边界

```text
Application
  -> RemoteInputClient              @remote-copy/sdk
    -> ProtocolSession              @remote-copy/protocol/implementations
      -> MessageCodec contract      @remote-copy/protocol
      -> JsonMessageCodec           @remote-copy/protocol/implementations
        -> SocketIoClientTransport  @remote-copy/protocol/implementations
```

定义自有实现时依赖 `@remote-copy/protocol`；使用标准 Session、Codec 或 Socket.IO Transport 时从 `@remote-copy/protocol/implementations` 引入。

## 验证

```bash
pnpm test:protocol
pnpm test:sdk
pnpm check
pnpm build
```

自动验证不得向真实 Server 发送非空 `input.submit`。
