import type { IdFactory } from "./id-factory.js";
import type { MessageCodec } from "./message-codec.js";
import type {
  NotificationMessage,
  ProtocolMethod,
  ProtocolNotificationMap,
  ProtocolNotificationName,
  ProtocolRequestMap,
  ProtocolResultMap,
} from "./messages.js";
import type { MessageTransport, TransportState } from "./message-transport.js";

/** Session 向 SDK 或 Server 发布的高层事件。 */
export type ProtocolSessionEvent =
  | { type: "transport-state"; state: TransportState }
  | { type: "notification"; notification: NotificationMessage }
  | { type: "error"; error: unknown };

/** 接收 Session 高层事件的监听器。 */
export type ProtocolSessionListener = (event: ProtocolSessionEvent) => void;

/** 请求处理器可使用的本次调用上下文。 */
export type ProtocolRequestContext = {
  /** 当前 Request 的短期关联标识。 */
  requestId: string;
};

/** 类型安全的方法处理器；返回值会被编码为该方法的成功 Response。 */
export type ProtocolRequestHandler<M extends ProtocolMethod> = (
  body: ProtocolRequestMap[M],
  context: ProtocolRequestContext,
) => ProtocolResultMap[M] | Promise<ProtocolResultMap[M]>;

/** 默认 Session 实现的可替换依赖和资源限制。 */
export type ProtocolSessionOptions = {
  /** 协议消息 Codec；缺省实现使用经过校验的 UTF-8 JSON。 */
  codec?: MessageCodec;
  /** Request/Response 关联 ID 工厂。 */
  createRequestId?: IdFactory;
  /** Ping/Pong 关联 ID 工厂。 */
  createHeartbeatId?: IdFactory;
  /** 单次请求等待 Response 的最长时间。 */
  requestTimeoutMs?: number;
  /** 同时等待 Response 的请求数量上限。 */
  maxPendingRequests?: number;
  /** 自动发送 Ping 的间隔；只有调用 `startHeartbeat` 后才生效。 */
  heartbeatIntervalMs?: number;
  /** Ping 发出后等待对应 Pong 的最长时间。 */
  heartbeatTimeoutMs?: number;
};

/**
 * Request/Response、Notification 和心跳的会话层契约。
 *
 * Session 不感知具体 Transport 类型，也不处理 Transport 分片或链路 ACK。
 */
export interface ProtocolSessionContract {
  readonly transport: MessageTransport;

  /** 连接底层 Transport；不会隐式调用 `session.open` 或启动心跳。 */
  connect(): Promise<void>;

  /** 停止心跳、清理未完成请求并断开 Transport。 */
  disconnect(): Promise<void>;

  /** 发送 Request 并等待具有相同 `requestId` 的成功 Response。 */
  request<M extends ProtocolMethod>(
    method: M,
    body: ProtocolRequestMap[M],
  ): Promise<ProtocolResultMap[M]>;

  /** 发送单向 Notification；完成时不代表远端已消费该通知。 */
  notify<N extends ProtocolNotificationName>(
    name: N,
    body: ProtocolNotificationMap[N],
  ): Promise<void>;

  /** 注册指定方法的唯一处理器，并返回取消注册函数。 */
  handleRequest<M extends ProtocolMethod>(
    method: M,
    handler: ProtocolRequestHandler<M>,
  ): () => void;

  /** 订阅 Session 事件，并返回取消订阅函数。 */
  subscribe(listener: ProtocolSessionListener): () => void;

  /** 启动 Session 心跳；重复调用不得创建多个心跳循环。 */
  startHeartbeat(): void;

  /** 停止心跳并清理正在等待的 Pong。 */
  stopHeartbeat(): void;
}
