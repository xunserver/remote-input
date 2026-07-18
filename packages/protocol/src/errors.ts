import type { RemoteErrorPayload } from "./messages.js";

export type DeliveryState = "not_sent" | "unknown" | "delivered";

export const sdkErrorCodes = {
  requestTimeout: "REQUEST_TIMEOUT",
  transportQueueFull: "TRANSPORT_QUEUE_FULL",
  transportNotConnected: "TRANSPORT_NOT_CONNECTED",
  messageTooLarge: "MESSAGE_TOO_LARGE",
  encodeError: "ENCODE_ERROR",
  deliveryUnconfirmed: "DELIVERY_UNCONFIRMED",
  transportDisconnected: "TRANSPORT_DISCONNECTED",
  sessionClosed: "SESSION_CLOSED",
  remoteError: "REMOTE_ERROR",
} as const;

export type SDKErrorCode = (typeof sdkErrorCodes)[keyof typeof sdkErrorCodes];

export type SDKErrorOptions = {
  cause?: unknown;
};

export class SDKError extends Error {
  readonly code: SDKErrorCode;
  readonly delivery: DeliveryState;

  constructor(
    code: SDKErrorCode,
    message: string,
    delivery: DeliveryState,
    options: SDKErrorOptions = {},
  ) {
    super(message);
    this.name = "SDKError";
    this.code = code;
    this.delivery = delivery;
    if (Object.hasOwn(options, "cause")) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
      });
    }
  }
}

export class RemoteError extends SDKError {
  readonly remoteError: RemoteErrorPayload;

  constructor(remoteError: RemoteErrorPayload) {
    super(
      sdkErrorCodes.remoteError,
      remoteError.message || "Remote handler failed.",
      "delivered",
    );
    this.name = "RemoteError";
    this.remoteError = remoteError;
  }
}

export function isSDKError(value: unknown): value is SDKError {
  return value instanceof SDKError;
}
