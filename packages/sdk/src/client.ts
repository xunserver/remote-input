import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  SDKError,
  Session,
  sdkErrorCodes,
  type JsonValue,
  type RequestHandler,
  type Transport,
} from "@remote-copy/protocol";

export interface ClientOptions {
  transport: Transport;
  requestTimeoutMs?: number;
}

export class Client {
  readonly #session: Session;

  constructor(options: ClientOptions) {
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError("requestTimeoutMs must be a positive finite number.");
    }
    this.#session = new Session(options.transport, { requestTimeoutMs });
  }

  sendText(text: string): Promise<JsonValue> {
    if (typeof text !== "string") {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.encodeError,
          "sendText requires a string.",
          "not_sent",
        ),
      );
    }
    return this.#session.request("sendText", { text });
  }

  request(method: string, payload: JsonValue): Promise<JsonValue> {
    return this.#session.request(method, payload);
  }

  registerHandler(method: string, handler: RequestHandler): () => void {
    return this.#session.registerHandler(method, handler);
  }

  close(): Promise<void> {
    return this.#session.close();
  }
}
