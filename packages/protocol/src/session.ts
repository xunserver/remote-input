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
  isRequestMessage,
  isResponseMessage,
  type ErrorResponseMessage,
  type RequestMessage,
  type ResponseMessage,
  type SuccessResponseMessage,
} from "./messages.js";
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
 * Symmetric request/response session layered over a single Transport.
 *
 * A transient Transport disconnect does not close the Session. It rejects all
 * current requests while preserving request IDs and handler registrations for
 * a later reconnect of the same Transport.
 */
export class Session implements TransportReceiver {
  readonly #transport: Transport;
  readonly #clock: ProtocolClock;
  readonly #requestTimeoutMs: number;
  readonly #onDiagnostic: (message: string, cause?: unknown) => void;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #handlers = new Map<string, HandlerRegistration>();

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
    const deadlineAt = requestedAt + this.#requestTimeoutMs;

    return new Promise<JsonValue>((resolve, reject) => {
      const timer = this.#scheduleRequestTimeout(requestId, deadlineAt);

      this.#pending.set(requestId, {
        resolve,
        reject,
        timer,
        deadlineAt,
        deliveryState: "not_sent",
        terminal: undefined,
        controller,
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
        // Transport.send is specified to return a rejected Promise for every
        // failure. Treat a non-conforming synchronous throw defensively so it
        // still cannot strand a Pending entry.
        this.#handleSendFailure(requestId, error);
        return;
      }

      void Promise.resolve(sendPromise).then(
        () => {
          // A resolved Transport.send is itself proof of delivery. This is a
          // defensive update in case a custom Transport omitted its callback.
          this.#advanceDelivery(requestId, "delivered");
        },
        (error: unknown) => {
          this.#handleSendFailure(requestId, error);
        },
      );
    });
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

  /**
   * Accepts one decoded Transport payload. It is deliberately synchronous and
   * never lets malformed input or scheduling failures escape to the Transport.
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

    this.#peerEpoch += 1;
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

    // Transport queues each send rejection before invoking disconnected().
    // Queueing this sweep lets those per-item errors preserve exact delivery
    // state; this only handles ACKed requests still waiting for a response (or
    // a defensive non-conforming Transport that failed to reject an item).
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
    this.#handlers.clear();
    this.#transport.unbind(this);

    for (const requestId of [...this.#pending.keys()]) {
      this.#settleReject(requestId, (pending) => {
        return this.#frozenTerminalError(pending)
          ?? (this.#clock.now() >= pending.deadlineAt
            ? this.#requestTimeoutError(pending.deliveryState)
            : this.#sessionClosedError("Session was closed.", pending.deliveryState));
      });
    }

    // Do not insert an await before this call: Transport.close must enter its
    // closing state in the same stack, before Abort-triggered FIFO pumps run.
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

    // The absolute deadline wins even when the timer callback has been delayed
    // by the event loop and this response callback happens to execute first.
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
    if (registration === undefined) {
      return;
    }

    const peerEpoch = this.#peerEpoch;
    const handler = registration.handler;
    const context: RequestContext = {
      requestId: message.requestId,
      method: message.method,
    };

    this.#queueMicrotask(() => {
      void this.#runHandler(handler, message.payload, context, peerEpoch);
    });
  }

  async #runHandler(
    handler: RequestHandler,
    payload: JsonValue,
    context: RequestContext,
    peerEpoch: number,
  ): Promise<void> {
    let response: SuccessResponseMessage | ErrorResponseMessage;

    try {
      const result = await handler(payload, context);

      if (!this.#canRespondTo(peerEpoch)) {
        this.#diagnose("Session dropped a handler result from an inactive peer epoch.");
        return;
      }

      if (result === undefined) {
        response = {
          type: "response",
          requestId: context.requestId,
          ok: true,
          data: null,
        };
      } else {
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

      response = this.#handlerErrorResponse(
        context.requestId,
        "HANDLER_ERROR",
        handlerErrorMessage,
      );
    }

    // Validation can inspect user-created objects (including Proxies), so make
    // the epoch/open check once more at the actual send boundary.
    if (!this.#canRespondTo(peerEpoch)) {
      this.#diagnose("Session dropped a handler response from an inactive peer epoch.");
      return;
    }

    try {
      await this.#transport.send(response);
    } catch (error) {
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
    pending?.resolve(value);
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
    taken?.reject(error);
  }

  #takePending(requestId: number): PendingRequest | undefined {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return undefined;
    }

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
      pending.deliveryState = delivery;
    }
  }

  #closeFromTransport(message: string): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#peerEpoch += 1;
    this.#handlers.clear();
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

    // As with disconnected(), Transport has already rejected its sends. Let
    // their Promise reactions retain item-level delivery before sweeping ACKed
    // requests that were only waiting for a response.
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
      // A runtime clock should not throw here. Falling back to the native queue
      // preserves accept()'s no-throw contract without running user code inline.
      this.#diagnose("Session clock failed to queue a microtask.", error);
      globalThis.queueMicrotask(callback);
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
      // Diagnostics must never affect protocol state.
    }
  }
}
