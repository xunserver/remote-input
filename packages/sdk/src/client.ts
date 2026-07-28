import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  SDKError,
  Session,
  sdkErrorCodes,
  type JsonValue,
  type NotificationHandler,
  type ProtocolTraceLevel,
  type ProtocolTraceListener,
  type RequestHandler,
  type Transport,
} from "@remote-input/protocol";
import {
  createSendTextPayload,
  inputStatusMethod,
  parseInputStatus,
  type InputStatusListener,
  type SendTextOptions,
} from "./input.js";

export interface ClientOptions {
  transport: Transport;
  requestTimeoutMs?: number;
  onTrace?: ProtocolTraceListener;
  traceLevel?: ProtocolTraceLevel;
}

export class Client {
  readonly #session: Session;

  constructor(options: ClientOptions) {
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError("requestTimeoutMs must be a positive finite number.");
    }
    this.#session = new Session(options.transport, {
      requestTimeoutMs,
      ...(options.onTrace === undefined ? {} : { onTrace: options.onTrace }),
      ...(options.traceLevel === undefined
        ? {}
        : { traceLevel: options.traceLevel }),
    });
  }

  sendText(
    text: string,
    options: SendTextOptions = {},
  ): Promise<JsonValue> {
    // 对无类型调用者仍保持 Promise 拒绝语义，并保证无效输入未触达传输层。
    if (typeof text !== "string") {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.encodeError,
          "sendText requires a string.",
          "not_sent",
        ),
      );
    }
    return this.#session.request(
      "sendText",
      createSendTextPayload(text, options),
    );
  }

  /**
   * 发送文字，但不等待远端业务 Response。
   *
   * Promise 完成只代表底层 Transport 已达到自身的发送成功边界；
   * 它不能证明远端已经处理或粘贴文字。
   */
  sendTextUnconfirmed(
    text: string,
    options: SendTextOptions = {},
  ): Promise<void> {
    if (typeof text !== "string") {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.encodeError,
          "sendTextUnconfirmed requires a string.",
          "not_sent",
        ),
      );
    }
    return this.#session.notify(
      "sendText",
      createSendTextPayload(text, options),
    );
  }

  request(method: string, payload: JsonValue): Promise<JsonValue> {
    return this.#session.request(method, payload);
  }

  registerHandler(method: string, handler: RequestHandler): () => void {
    return this.#session.registerHandler(method, handler);
  }

  registerNotificationHandler(
    method: string,
    handler: NotificationHandler,
  ): () => void {
    return this.#session.registerNotificationHandler(method, handler);
  }

  onInputStatus(listener: InputStatusListener): () => void {
    return this.registerNotificationHandler(inputStatusMethod, (payload) => {
      listener(parseInputStatus(payload));
    });
  }

  close(): Promise<void> {
    return this.#session.close();
  }
}
