import { systemClock, type ProtocolClock, type TimeoutHandle } from "./clock.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./constants.js";
import {
  RemoteError,
  SDKError,
  isSDKError,
  sdkErrorCodes,
  type DeliveryState,
  type SDKErrorCode,
} from "./errors.js";
import { snapshotJsonValue, type JsonValue } from "./json.js";
import {
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
  type ErrorResponseMessage,
  type NotificationMessage,
  type RequestMessage,
  type ResponseMessage,
  type SuccessResponseMessage,
} from "./messages.js";
import {
  queueProtocolTrace,
  type ProtocolTraceDetails,
  type ProtocolTraceLevel,
  type ProtocolTraceListener,
} from "./trace.js";
import type {
  ProtocolRuntimeOptions,
  Transport,
  TransportReceiver,
} from "./transport.js";

export type RequestContext = {
  requestId: number;
  method: string;
};

export type RequestHandler = (
  payload: JsonValue,
  context: RequestContext,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export type NotificationContext = {
  method: string;
};

export type NotificationHandler = (
  payload: JsonValue,
  context: NotificationContext,
) => void | Promise<void>;

export interface SessionOptions extends ProtocolRuntimeOptions {
  requestTimeoutMs?: number;
}

type PendingRequest = {
  resolve(value: JsonValue): void;
  reject(error: SDKError): void;
  timer: TimeoutHandle;
  deadlineAt: number;
  deliveryState: DeliveryState;
  terminal: PendingTerminal | undefined;
  controller: AbortController;
};

// 冻结断连或关闭时的首个终止事件，避免后续异步结果覆盖当时的投递状态。
type PendingTerminal =
  | {
    kind: "disconnect";
    cause: SDKError;
    deliveryState: DeliveryState;
  }
  | {
    kind: "closed";
    message: string;
    deliveryState: DeliveryState;
  };

type HandlerRegistration = {
  handler: RequestHandler;
  token: symbol;
};

type NotificationHandlerRegistration = {
  handler: NotificationHandler;
  token: symbol;
};

// 投递状态只允许单向推进，避免乱序回调降低已经确认的状态。
const deliveryRank: Readonly<Record<DeliveryState, number>> = {
  not_sent: 0,
  unknown: 1,
  delivered: 2,
};

const handlerErrorMessage = "Remote handler failed.";
const responseNotSerializableMessage =
  "Remote handler returned a non-serializable response.";
const maxTimerDelayMs = 2_147_483_647;

/**
 * 构建在单个 Transport 之上的双向请求/响应会话。
 *
 * Transport 暂时断连不会关闭 Session。当前请求会被拒绝，但请求 ID 进度和
 * handler 注册会保留，供同一 Transport 后续重连继续使用。
 */
export class Session implements TransportReceiver {
  readonly #transport: Transport;
  readonly #clock: ProtocolClock;
  readonly #requestTimeoutMs: number;
  readonly #onDiagnostic: (message: string, cause?: unknown) => void;
  readonly #onTrace: ProtocolTraceListener | undefined;
  readonly #traceLevel: ProtocolTraceLevel;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #handlers = new Map<string, HandlerRegistration>();
  readonly #notificationHandlers =
    new Map<string, NotificationHandlerRegistration>();

  #nextRequestId = 1;
  #requestIdsExhausted = false;
  #peerEpoch = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(transport: Transport, options: SessionOptions = {}) {
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be a finite number greater than 0.");
    }

    this.#transport = transport;
    this.#clock = options.clock ?? systemClock;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#onTrace = options.onTrace;
    const traceLevel = options.traceLevel ?? "summary";
    if (traceLevel !== "summary" && traceLevel !== "chunks") {
      throw new RangeError('traceLevel must be either "summary" or "chunks".');
    }
    this.#traceLevel = traceLevel;

    this.#transport.bind(this);
  }

  request(method: string, payload: JsonValue): Promise<JsonValue> {
    if (this.#closed) {
      return Promise.reject(this.#sessionClosedError("Session is closed.", "not_sent"));
    }

    if (this.#requestIdsExhausted) {
      return Promise.reject(
        this.#sessionClosedError(
          "Session requestId space is exhausted; create a new Session.",
          "not_sent",
        ),
      );
    }

    const requestId = this.#allocateRequestId();
    const message: RequestMessage = {
      type: "request",
      requestId,
      method,
      payload,
    };
    const controller = new AbortController();
    const requestedAt = this.#clock.now();
    // 绝对截止时间覆盖排队、发送及等待响应的全过程。
    const deadlineAt = requestedAt + this.#requestTimeoutMs;

    return new Promise<JsonValue>((resolve, reject) => {
      const timer = this.#scheduleRequestTimeout(requestId, deadlineAt);

      // 必须先登记请求再发送，Transport 可能在 send 返回前同步回送响应。
      this.#pending.set(requestId, {
        resolve,
        reject,
        timer,
        deadlineAt,
        deliveryState: "not_sent",
        terminal: undefined,
        controller,
      });
      this.#trace("request.pending", {
        requestId,
        pendingCount: this.#pending.size,
        deadlineAt,
        peerEpoch: this.#peerEpoch,
      });

      let sendPromise: Promise<void>;
      try {
        sendPromise = this.#transport.send(message, {
          signal: controller.signal,
          deadlineAt,
          onDeliveryChange: (delivery) => {
            this.#advanceDelivery(requestId, delivery);
          },
        });
      } catch (error) {
        // Transport.send 按约定应以 rejected Promise 表示失败；这里仍防御性处理
        // 不符合约定的同步抛错，避免遗留无法结算的 Pending 记录。
        this.#handleSendFailure(requestId, error);
        return;
      }

      void Promise.resolve(sendPromise).then(
        () => {
          // send 成功本身即可证明已投递；即使自定义 Transport 漏掉回调，
          // 这里也会防御性地推进投递状态。
          this.#advanceDelivery(requestId, "delivered");
        },
        (error: unknown) => {
          this.#handleSendFailure(requestId, error);
        },
      );
    });
  }

  /** 发送一个没有 requestId、对端也不会响应的单向通知。 */
  notify(method: string, payload: JsonValue): Promise<void> {
    if (this.#closed) {
      return Promise.reject(this.#sessionClosedError("Session is closed.", "not_sent"));
    }

    const message: NotificationMessage = {
      type: "notify",
      method,
      payload,
    };

    try {
      return Promise.resolve(this.#transport.send(message));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  registerHandler(method: string, handler: RequestHandler): () => void {
    if (this.#closed) {
      throw this.#sessionClosedError("Session is closed.", "not_sent");
    }
    if (typeof method !== "string") {
      throw new TypeError("method must be a string.");
    }
    if (typeof handler !== "function") {
      throw new TypeError("handler must be a function.");
    }

    const token = Symbol(method);
    // token 将注销函数绑定到本次注册，旧注销函数不能误删同名的新 handler。
    this.#handlers.set(method, { handler, token });

    let unregistered = false;
    return () => {
      if (unregistered) {
        return;
      }
      unregistered = true;
      if (this.#handlers.get(method)?.token === token) {
        this.#handlers.delete(method);
      }
    };
  }

  registerNotificationHandler(
    method: string,
    handler: NotificationHandler,
  ): () => void {
    if (this.#closed) {
      throw this.#sessionClosedError("Session is closed.", "not_sent");
    }
    if (typeof method !== "string") {
      throw new TypeError("method must be a string.");
    }
    if (typeof handler !== "function") {
      throw new TypeError("handler must be a function.");
    }

    const token = Symbol(method);
    this.#notificationHandlers.set(method, { handler, token });
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      if (this.#notificationHandlers.get(method)?.token === token) {
        this.#notificationHandlers.delete(method);
      }
    };
  }

  /**
   * 接收一个已解码的 Transport 消息。此入口刻意保持同步，并确保畸形输入或
   * 调度失败不会向外逃逸到 Transport。
   */
  accept(message: JsonValue): void {
    if (this.#closed) {
      return;
    }

    try {
      if (isResponseMessage(message)) {
        this.#acceptResponse(message);
        return;
      }

      if (isNotificationMessage(message)) {
        this.#acceptNotification(message);
        return;
      }

      if (isRequestMessage(message)) {
        this.#acceptRequest(message);
      }
    } catch (error) {
      this.#diagnose("Session ignored a message after an internal accept failure.", error);
    }
  }

  disconnected(error: SDKError): void {
    if (this.#closed) {
      return;
    }

    // 断连不关闭 Session，但会使旧连接上尚未完成的 handler 失效。
    this.#peerEpoch += 1;
    this.#trace("transport.disconnected", {
      peerEpoch: this.#peerEpoch,
      pendingCount: this.#pending.size,
      errorCode: error.code,
      delivery: error.delivery,
    });
    // 限定本轮清理范围，避免稍后的微任务误伤断连后新建的请求。
    const pendingAtDisconnect = [...this.#pending.keys()];
    const disconnectedAt = this.#clock.now();
    for (const requestId of pendingAtDisconnect) {
      const pending = this.#pending.get(requestId);
      if (pending === undefined || pending.terminal !== undefined) {
        continue;
      }
      if (disconnectedAt >= pending.deadlineAt) {
        this.#settleReject(
          requestId,
          (current) => this.#requestTimeoutError(current.deliveryState),
        );
      } else {
        pending.terminal = {
          kind: "disconnect",
          cause: error,
          deliveryState: pending.deliveryState,
        };
      }
    }

    // Transport 会先排入各 send 的 rejection，再调用 disconnected()。因此将
    // 批量清理推迟到微任务，让逐项错误保留精确投递状态；这里只兜底处理已 ACK
    // 但仍在等待响应的请求，以及未按约定 reject 的自定义 Transport。
    this.#queueMicrotask(() => {
      for (const requestId of pendingAtDisconnect) {
        this.#settleReject(requestId, (pending) => {
          return this.#frozenTerminalError(pending)
            ?? this.#transportDisconnectedError(error, pending.deliveryState);
        });
      }
    });
  }

  localClosed(): void {
    this.#closeFromTransport("Transport was closed locally.");
  }

  peerClosed(): void {
    this.#closeFromTransport("The remote peer closed the session.");
  }

  close(): Promise<void> {
    if (this.#closed) {
      return this.#closePromise ?? Promise.resolve();
    }

    this.#closed = true;
    this.#peerEpoch += 1;
    this.#trace("session.close", {
      peerEpoch: this.#peerEpoch,
      pendingCount: this.#pending.size,
    });
    this.#handlers.clear();
    this.#notificationHandlers.clear();
    this.#transport.unbind(this);

    for (const requestId of [...this.#pending.keys()]) {
      this.#settleReject(requestId, (pending) => {
        return this.#frozenTerminalError(pending)
          ?? (this.#clock.now() >= pending.deadlineAt
            ? this.#requestTimeoutError(pending.deliveryState)
            : this.#sessionClosedError("Session was closed.", pending.deliveryState));
      });
    }

    // 此调用前不能插入 await：Transport.close 必须在同一调用栈内进入 closing，
    // 早于 Abort 触发的 FIFO 发送泵继续运行。
    let closeResult: Promise<void>;
    try {
      closeResult = this.#transport.close();
    } catch (error) {
      closeResult = Promise.reject(error);
    }
    this.#closePromise = Promise.resolve(closeResult);
    return this.#closePromise;
  }

  #allocateRequestId(): number {
    // ID 不循环复用，避免迟到响应命中新请求；安全整数耗尽后必须创建新 Session。
    const requestId = this.#nextRequestId;
    if (requestId === Number.MAX_SAFE_INTEGER) {
      this.#requestIdsExhausted = true;
    } else {
      this.#nextRequestId = requestId + 1;
    }
    return requestId;
  }

  #scheduleRequestTimeout(
    requestId: number,
    deadlineAt: number,
  ): TimeoutHandle {
    const remaining = deadlineAt - this.#clock.now();
    // 单次定时器受平台上限约束；超长截止时间需分段调度并复核绝对时间。
    const delay = Math.min(maxTimerDelayMs, Math.max(0, remaining));
    return this.#clock.setTimeout(() => {
      const pending = this.#pending.get(requestId);
      if (pending === undefined) {
        return;
      }
      if (this.#clock.now() < pending.deadlineAt) {
        pending.timer = this.#scheduleRequestTimeout(
          requestId,
          pending.deadlineAt,
        );
        return;
      }
      this.#settleReject(
        requestId,
        (current) => {
          return this.#frozenTerminalError(current)
            ?? this.#requestTimeoutError(current.deliveryState);
        },
      );
    }, delay);
  }

  #acceptResponse(message: ResponseMessage): void {
    const pending = this.#pending.get(message.requestId);
    this.#trace("response.received", {
      requestId: message.requestId,
      ok: message.ok,
      matchedPending: pending !== undefined,
      pendingCount: this.#pending.size,
    });
    if (pending === undefined) {
      return;
    }
    const frozenTerminalError = this.#frozenTerminalError(pending);
    if (frozenTerminalError !== undefined) {
      this.#settleReject(
        message.requestId,
        () => frozenTerminalError,
      );
      return;
    }

    this.#advanceDelivery(message.requestId, "delivered");

    // 即使事件循环延迟了定时器回调，绝对截止时间仍优先于恰好先执行的响应回调。
    if (this.#clock.now() >= pending.deadlineAt) {
      this.#settleReject(
        message.requestId,
        (current) => this.#requestTimeoutError(current.deliveryState),
      );
      return;
    }

    if (message.ok) {
      this.#settleResolve(message.requestId, message.data);
      return;
    }

    this.#settleReject(message.requestId, () => new RemoteError(message.error));
  }

  #acceptRequest(message: RequestMessage): void {
    const registration = this.#handlers.get(message.method);
    this.#trace("request.received", {
      requestId: message.requestId,
      handlerRegistered: registration !== undefined,
      peerEpoch: this.#peerEpoch,
    });
    if (registration === undefined) {
      return;
    }

    // 捕获请求所属的连接世代，禁止异步 handler 将旧连接的结果发到重连后的对端。
    const peerEpoch = this.#peerEpoch;
    const handler = registration.handler;
    const context: RequestContext = {
      requestId: message.requestId,
      method: message.method,
    };
    this.#trace("handler.scheduled", {
      requestId: context.requestId,
      peerEpoch,
    });

    // 异步启动用户代码，使 accept() 保持同步且不同请求可以并发处理。
    this.#queueMicrotask(() => {
      void this.#runHandler(handler, message.payload, context, peerEpoch);
    });
  }

  #acceptNotification(message: NotificationMessage): void {
    const registration = this.#notificationHandlers.get(message.method);
    if (registration === undefined) return;
    const handler = registration.handler;
    const context: NotificationContext = { method: message.method };
    this.#queueMicrotask(() => {
      void Promise.resolve(handler(message.payload, context)).catch((error) => {
        this.#diagnose("Session notification handler failed.", error);
      });
    });
  }

  async #runHandler(
    handler: RequestHandler,
    payload: JsonValue,
    context: RequestContext,
    peerEpoch: number,
  ): Promise<void> {
    let response: SuccessResponseMessage | ErrorResponseMessage;
    this.#trace("handler.started", {
      requestId: context.requestId,
      peerEpoch,
    });

    try {
      const result = await handler(payload, context);

      if (!this.#canRespondTo(peerEpoch)) {
        this.#diagnose("Session dropped a handler result from an inactive peer epoch.");
        return;
      }

      if (result === undefined) {
        // JSON 不支持 undefined，未返回值统一映射为 null。
        response = {
          type: "response",
          requestId: context.requestId,
          ok: true,
          data: null,
        };
      } else {
        // 固化返回值，避免用户在校验后、实际发送前再次修改对象。
        const data = this.#snapshotJsonValueSafely(result);
        if (data === undefined) {
          response = this.#handlerErrorResponse(
            context.requestId,
            "RESPONSE_NOT_SERIALIZABLE",
            responseNotSerializableMessage,
          );
        } else {
          response = {
            type: "response",
            requestId: context.requestId,
            ok: true,
            data,
          };
        }
      }
    } catch (error) {
      if (!this.#canRespondTo(peerEpoch)) {
        this.#diagnose(
          "Session dropped a handler error from an inactive peer epoch.",
          error,
        );
        return;
      }

      // 只返回稳定的通用错误，不向对端暴露本地异常细节。
      response = this.#handlerErrorResponse(
        context.requestId,
        "HANDLER_ERROR",
        handlerErrorMessage,
      );
    }

    // 校验可能检查用户创建的对象（包括 Proxy），因此在实际发送边界再次确认
    // 连接世代和会话状态。
    if (!this.#canRespondTo(peerEpoch)) {
      this.#diagnose("Session dropped a handler response from an inactive peer epoch.");
      return;
    }

    this.#trace("handler.completed", {
      requestId: context.requestId,
      ok: response.ok,
      errorCode: response.ok ? null : response.error.code,
      peerEpoch,
    });
    this.#trace("response.send", {
      requestId: context.requestId,
      ok: response.ok,
      errorCode: response.ok ? null : response.error.code,
      peerEpoch,
    });

    try {
      await this.#transport.send(response);
      this.#trace("response.sent", {
        requestId: context.requestId,
        ok: response.ok,
        peerEpoch,
      });
    } catch (error) {
      this.#trace("response.sendFailed", {
        requestId: context.requestId,
        ok: response.ok,
        reason: traceSessionErrorReason(error),
        peerEpoch,
      });
      // 响应发送失败只做诊断，避免递归尝试发送新的错误响应。
      this.#diagnose("Session failed to send a handler response.", error);
    }
  }

  #handlerErrorResponse(
    requestId: number,
    code: string,
    message: string,
  ): ErrorResponseMessage {
    return {
      type: "response",
      requestId,
      ok: false,
      error: { code, message },
    };
  }

  #canRespondTo(peerEpoch: number): boolean {
    return !this.#closed && this.#peerEpoch === peerEpoch;
  }

  #snapshotJsonValueSafely(value: unknown): JsonValue | undefined {
    try {
      return snapshotJsonValue(value);
    } catch (error) {
      this.#diagnose("Session could not validate a handler result.", error);
      return undefined;
    }
  }

  #handleSendFailure(requestId: number, error: unknown): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return;
    }

    if (isSDKError(error)) {
      this.#advanceDelivery(requestId, error.delivery);
    }

    // 首个终止事件优先，其次按绝对超时、会话关闭、Transport 错误归一化。
    this.#settleReject(requestId, (current) => {
      const frozenTerminalError = this.#frozenTerminalError(current);
      if (frozenTerminalError !== undefined) {
        return frozenTerminalError;
      }

      if (
        this.#clock.now() >= current.deadlineAt ||
        (isSDKError(error) && error.code === sdkErrorCodes.requestTimeout)
      ) {
        return this.#requestTimeoutError(current.deliveryState, error);
      }

      if (this.#closed) {
        return this.#sessionClosedError(
          "Session was closed.",
          current.deliveryState,
          error,
        );
      }

      return this.#normalizeTransportError(error, current.deliveryState);
    });
  }

  #settleResolve(requestId: number, value: JsonValue): void {
    const pending = this.#takePending(requestId);
    if (pending === undefined) {
      return;
    }
    this.#trace("request.resolved", {
      requestId,
      delivery: pending.deliveryState,
      pendingCount: this.#pending.size,
    });
    pending.resolve(value);
  }

  #settleReject(
    requestId: number,
    createError: (pending: PendingRequest) => SDKError,
  ): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return;
    }

    const error = createError(pending);
    const taken = this.#takePending(requestId);
    if (taken === undefined) {
      return;
    }
    this.#trace("request.rejected", {
      requestId,
      errorCode: error.code,
      delivery: error.delivery,
      pendingCount: this.#pending.size,
    });
    taken.reject(error);
  }

  #takePending(requestId: number): PendingRequest | undefined {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return undefined;
    }

    // 先删除记录再中止发送，使 Abort 引发的后续 rejection 无法重复结算。
    this.#pending.delete(requestId);
    this.#clock.clearTimeout(pending.timer);
    pending.controller.abort();
    return pending;
  }

  #advanceDelivery(requestId: number, delivery: DeliveryState): void {
    const pending = this.#pending.get(requestId);
    if (
      pending !== undefined &&
      deliveryRank[delivery] > deliveryRank[pending.deliveryState]
    ) {
      const previous = pending.deliveryState;
      pending.deliveryState = delivery;
      this.#trace("request.delivery", {
        requestId,
        previous,
        delivery,
      });
    }
  }

  #closeFromTransport(message: string): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#peerEpoch += 1;
    this.#trace("transport.closed", {
      peerEpoch: this.#peerEpoch,
      pendingCount: this.#pending.size,
      reason: message,
    });
    this.#handlers.clear();
    this.#notificationHandlers.clear();
    this.#transport.unbind(this);

    const pendingAtClose = [...this.#pending.keys()];
    const closedAt = this.#clock.now();
    for (const requestId of pendingAtClose) {
      const pending = this.#pending.get(requestId);
      if (pending === undefined || pending.terminal !== undefined) {
        continue;
      }
      if (closedAt >= pending.deadlineAt) {
        this.#settleReject(
          requestId,
          (current) => this.#requestTimeoutError(current.deliveryState),
        );
      } else {
        pending.terminal = {
          kind: "closed",
          message,
          deliveryState: pending.deliveryState,
        };
      }
    }

    // 与 disconnected() 相同，Transport 已先 reject 各 send；让其 Promise
    // 回调先保留逐项投递状态，再清理已 ACK、仅等待响应的请求。
    this.#queueMicrotask(() => {
      for (const requestId of pendingAtClose) {
        this.#settleReject(requestId, (pending) => {
          return this.#frozenTerminalError(pending)
            ?? this.#sessionClosedError(message, pending.deliveryState);
        });
      }
    });
  }

  #frozenTerminalError(pending: PendingRequest): SDKError | undefined {
    const terminal = pending.terminal;
    if (terminal === undefined) {
      return undefined;
    }
    return terminal.kind === "disconnect"
      ? this.#transportDisconnectedError(
        terminal.cause,
        terminal.deliveryState,
      )
      : this.#sessionClosedError(
        terminal.message,
        terminal.deliveryState,
      );
  }

  #requestTimeoutError(delivery: DeliveryState, cause?: unknown): SDKError {
    return this.#newError(
      sdkErrorCodes.requestTimeout,
      "Request timed out.",
      delivery,
      cause,
    );
  }

  #sessionClosedError(
    message: string,
    delivery: DeliveryState,
    cause?: unknown,
  ): SDKError {
    return this.#newError(
      sdkErrorCodes.sessionClosed,
      message,
      delivery,
      cause,
    );
  }

  #transportDisconnectedError(
    cause: SDKError,
    delivery: DeliveryState,
  ): SDKError {
    return this.#newError(
      sdkErrorCodes.transportDisconnected,
      "Transport disconnected.",
      delivery,
      cause,
    );
  }

  #normalizeTransportError(
    error: unknown,
    delivery: DeliveryState,
  ): SDKError {
    if (isSDKError(error)) {
      if (error.delivery === delivery) {
        return error;
      }
      return this.#newError(error.code, error.message, delivery, error);
    }

    return this.#newError(
      sdkErrorCodes.transportDisconnected,
      "Transport send failed.",
      delivery,
      error,
    );
  }

  #newError(
    code: SDKErrorCode,
    message: string,
    delivery: DeliveryState,
    cause?: unknown,
  ): SDKError {
    return cause === undefined
      ? new SDKError(code, message, delivery)
      : new SDKError(code, message, delivery, { cause });
  }

  #queueMicrotask(callback: () => void): void {
    try {
      this.#clock.queueMicrotask(callback);
    } catch (error) {
      // 运行时 clock 不应在此抛错；回退到原生微任务队列，既维持 accept()
      // 不抛异常的约定，也避免同步执行用户代码。
      this.#diagnose("Session clock failed to queue a microtask.", error);
      globalThis.queueMicrotask(callback);
    }
  }

  #trace(
    event: string,
    details: ProtocolTraceDetails,
    level: ProtocolTraceLevel = "summary",
  ): void {
    if (
      this.#onTrace === undefined ||
      (level === "chunks" && this.#traceLevel !== "chunks")
    ) {
      return;
    }
    try {
      queueProtocolTrace(this.#onTrace, {
        at: this.#clock.now(),
        layer: "session",
        event,
        details,
      });
    } catch {
      // A diagnostic/debug clock or event shape must never change Session state.
    }
  }

  #diagnose(message: string, cause?: unknown): void {
    try {
      if (cause === undefined) {
        this.#onDiagnostic(message);
      } else {
        this.#onDiagnostic(message, cause);
      }
    } catch {
      // 诊断回调绝不能影响协议状态。
    }
  }
}

function traceSessionErrorReason(error: unknown): string {
  try {
    if (isSDKError(error)) {
      return error.code;
    }
  } catch {
    return "error";
  }
  return "error";
}
