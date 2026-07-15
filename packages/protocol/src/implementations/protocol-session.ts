import type { MessageCodec } from "../definitions/message-codec.js";
import {
  maxPendingRequests,
  protocolVersion,
  type NotificationMessage,
  type ProtocolError,
  type ProtocolMethod,
  type ProtocolNotificationMap,
  type ProtocolNotificationName,
  type ProtocolRequestMap,
  type ProtocolResultMap,
  type RequestMessage,
} from "../definitions/messages.js";
import type { MessageTransport } from "../definitions/message-transport.js";
import type {
  ProtocolRequestContext,
  ProtocolRequestHandler,
  ProtocolSessionContract,
  ProtocolSessionEvent,
  ProtocolSessionListener,
  ProtocolSessionOptions,
} from "../definitions/protocol-session.js";
import type { IdFactory } from "../definitions/id-factory.js";
import { createHeartbeatId, createRequestId } from "./ids.js";
import { JsonMessageCodec } from "./json-message-codec.js";
import { parseResultBody } from "./validation.js";

/** 对端返回的结构化失败 Response。 */
export class ProtocolResponseError extends Error {
  /** 对端提供的错误码、消息和可重试语义。 */
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = "ProtocolResponseError";
  }
}

/** 请求处理器用于主动返回结构化失败 Response 的错误。 */
export class ProtocolRequestError extends Error {
  readonly protocolError: ProtocolError;

  /** 创建将被发送给请求方的协议错误。 */
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ProtocolRequestError";
    this.protocolError = { code, message, retryable };
  }
}

type PendingRequest = {
  method: ProtocolMethod;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type AnyRequestHandler = (
  body: unknown,
  context: ProtocolRequestContext,
) => unknown | Promise<unknown>;

/**
 * 默认 ProtocolSession 实现。
 *
 * 负责 Request/Response 关联、超时、处理器、通知分发和心跳；
 * 不解析具体 Transport，也不承担分片、重组或链路 ACK。
 */
export class ProtocolSession implements ProtocolSessionContract {
  private readonly listeners = new Set<ProtocolSessionListener>();
  private readonly handlers = new Map<ProtocolMethod, AnyRequestHandler>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly codec: MessageCodec;
  private readonly requestIdFactory: IdFactory;
  private readonly heartbeatIdFactory: IdFactory;
  private readonly requestTimeoutMs: number;
  private readonly pendingLimit: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private unsubscribeTransport: (() => void) | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingHeartbeatId: string | null = null;
  private generation = 0;

  /** 使用给定消息 Transport 创建 Session，并允许替换 Codec、ID 工厂和资源限制。 */
  constructor(
    readonly transport: MessageTransport,
    options: ProtocolSessionOptions = {},
  ) {
    this.codec = options.codec ?? new JsonMessageCodec();
    this.requestIdFactory = options.createRequestId ?? createRequestId;
    this.heartbeatIdFactory = options.createHeartbeatId ?? createHeartbeatId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.pendingLimit = options.maxPendingRequests ?? maxPendingRequests;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;
  }

  /** 订阅并连接 Transport；不会隐式执行 `session.open` 或启动心跳。 */
  async connect(): Promise<void> {
    const generation = ++this.generation;
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = this.transport.subscribe((event) => {
      if (this.generation === generation) {
        this.handleTransportEvent(event);
      }
    });

    try {
      await this.transport.connect();
    } catch (error) {
      if (this.generation === generation) {
        this.unsubscribeTransport?.();
        this.unsubscribeTransport = null;
      }
      throw error;
    }
  }

  /** 停止心跳、拒绝未完成请求并断开 Transport。 */
  async disconnect(): Promise<void> {
    ++this.generation;
    this.stopHeartbeat();
    this.rejectPending(new Error("Protocol session disconnected."));
    const unsubscribe = this.unsubscribeTransport;
    this.unsubscribeTransport = null;
    await this.transport.disconnect();
    unsubscribe?.();
  }

  /** 发送类型安全的 Request，并等待对应的成功 Response。 */
  async request<M extends ProtocolMethod>(
    method: M,
    body: ProtocolRequestMap[M],
  ): Promise<ProtocolResultMap[M]> {
    if (this.transport.state !== "connected") {
      throw new Error("Protocol transport is not connected.");
    }
    if (this.pendingRequests.size >= this.pendingLimit) {
      throw new Error(`Protocol session has reached the pending request limit of ${this.pendingLimit}.`);
    }

    const requestId = this.requestIdFactory();
    if (!requestId || this.pendingRequests.has(requestId)) {
      throw new Error(`Protocol request ID is empty or already pending: ${requestId || "<empty>"}.`);
    }

    const message: RequestMessage<M> = {
      v: protocolVersion,
      kind: "request",
      requestId,
      method,
      body,
    } as RequestMessage<M>;

    const response = new Promise<ProtocolResultMap[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Protocol request timed out: ${method}.`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(requestId, {
        method,
        resolve: (value) => resolve(value as ProtocolResultMap[M]),
        reject,
        timer,
      });
    });

    try {
      await this.send(message);
    } catch (error) {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        pending.reject(error);
      }
    }

    return response;
  }

  /** 发送不需要 Response 的单向 Notification。 */
  notify<N extends ProtocolNotificationName>(
    name: N,
    body: ProtocolNotificationMap[N],
  ): Promise<void> {
    return this.send({ v: protocolVersion, kind: "notification", name, body } as NotificationMessage<N>);
  }

  /** 注册指定方法的处理器；再次注册会替换之前的处理器。 */
  handleRequest<M extends ProtocolMethod>(method: M, handler: ProtocolRequestHandler<M>): () => void {
    const storedHandler = handler as unknown as AnyRequestHandler;
    this.handlers.set(method, storedHandler);
    return () => {
      if (this.handlers.get(method) === storedHandler) {
        this.handlers.delete(method);
      }
    };
  }

  /** 订阅 Session 事件。 */
  subscribe(listener: ProtocolSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 启动单实例心跳循环；调用前会清理已有循环。 */
  startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0 || this.heartbeatTimeoutMs <= 0) {
      return;
    }
    this.heartbeatInterval = setInterval(() => {
      void this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  /** 停止心跳循环和等待中的 Pong 超时计时器。 */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    this.pendingHeartbeatId = null;
  }

  private handleTransportEvent(event: import("../definitions/message-transport.js").TransportEvent): void {
    if (event.type === "state") {
      if (event.state === "disconnected" || event.state === "error") {
        this.stopHeartbeat();
        this.rejectPending(new Error(`Protocol transport entered ${event.state} state.`));
      }
      this.emit({ type: "transport-state", state: event.state });
      return;
    }
    if (event.type === "error") {
      this.emit({ type: "error", error: event.error });
      return;
    }

    try {
      const message = this.codec.decode(event.message);
      if (message.kind === "response") {
        this.handleResponse(message);
      } else if (message.kind === "notification") {
        this.emit({ type: "notification", notification: message });
      } else if (message.kind === "request") {
        void this.handleIncomingRequest(message);
      } else if (message.kind === "ping") {
        void this.send({ v: protocolVersion, kind: "pong", heartbeatId: message.heartbeatId });
      } else {
        this.handlePong(message.heartbeatId);
      }
    } catch (error) {
      this.emit({ type: "error", error });
    }
  }

  private handleResponse(message: import("../definitions/messages.js").ResponseMessage): void {
    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      this.emit({ type: "error", error: new Error(`Received an unknown or late response: ${message.requestId}.`) });
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.requestId);
    if (!message.ok) {
      pending.reject(new ProtocolResponseError(message.error));
      return;
    }
    try {
      pending.resolve(parseResultBody(pending.method, message.body));
    } catch (error) {
      pending.reject(error);
    }
  }

  private async handleIncomingRequest(message: RequestMessage): Promise<void> {
    const handler = this.handlers.get(message.method);
    if (!handler) {
      await this.sendError(message.requestId, {
        code: "method.unsupported",
        message: `No handler is registered for ${message.method}.`,
        retryable: false,
      });
      return;
    }

    try {
      const body = parseResultBody(message.method, await handler(message.body, { requestId: message.requestId }));
      await this.send({
        v: protocolVersion,
        kind: "response",
        requestId: message.requestId,
        ok: true,
        body,
      });
    } catch (error) {
      const protocolError = error instanceof ProtocolRequestError
        ? error.protocolError
        : {
            code: "request.failed",
            message: error instanceof Error ? error.message : "Protocol request failed.",
            retryable: false,
          };
      await this.sendError(message.requestId, protocolError);
    }
  }

  private sendError(requestId: string, error: ProtocolError): Promise<void> {
    return this.send({ v: protocolVersion, kind: "response", requestId, ok: false, error });
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.transport.state !== "connected" || this.pendingHeartbeatId) {
      return;
    }
    const heartbeatId = this.heartbeatIdFactory();
    if (!heartbeatId) {
      this.emit({ type: "error", error: new Error("Heartbeat ID must not be empty.") });
      return;
    }
    try {
      await this.send({ v: protocolVersion, kind: "ping", heartbeatId });
      this.pendingHeartbeatId = heartbeatId;
      this.heartbeatTimeout = setTimeout(() => {
        if (this.pendingHeartbeatId !== heartbeatId) {
          return;
        }
        const error = new Error(`Protocol heartbeat timed out: ${heartbeatId}.`);
        this.emit({ type: "error", error });
        this.rejectPending(error);
        this.stopHeartbeat();
        void this.transport.disconnect();
      }, this.heartbeatTimeoutMs);
    } catch (error) {
      this.emit({ type: "error", error });
    }
  }

  private handlePong(heartbeatId: string): void {
    if (heartbeatId !== this.pendingHeartbeatId) {
      this.emit({ type: "error", error: new Error(`Received an unknown pong: ${heartbeatId}.`) });
      return;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    this.pendingHeartbeatId = null;
  }

  private send(message: import("../definitions/messages.js").ProtocolMessage): Promise<void> {
    return this.transport.send(this.codec.encode(message));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private emit(event: ProtocolSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
