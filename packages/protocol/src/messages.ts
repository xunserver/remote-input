import { isJsonValue, type JsonValue } from "./json.js";

export type RequestMessage = {
  type: "request";
  requestId: number;
  method: string;
  payload: JsonValue;
};

export type SuccessResponseMessage = {
  type: "response";
  requestId: number;
  ok: true;
  data: JsonValue;
};

export type RemoteErrorPayload = {
  code: string;
  message?: string;
  details?: JsonValue;
};

export type ErrorResponseMessage = {
  type: "response";
  requestId: number;
  ok: false;
  error: RemoteErrorPayload;
};

export type ResponseMessage =
  | SuccessResponseMessage
  | ErrorResponseMessage;

export type SessionMessage = RequestMessage | ResponseMessage;

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

export function isRequestMessage(value: unknown): value is RequestMessage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.type === "request" &&
    isPositiveSafeInteger(value.requestId) &&
    typeof value.method === "string" &&
    isJsonValue(value.payload)
  );
}

export function isResponseMessage(value: unknown): value is ResponseMessage {
  if (
    !isRecord(value) ||
    value.type !== "response" ||
    !isPositiveSafeInteger(value.requestId) ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }

  if (value.ok) {
    return isJsonValue(value.data);
  }

  if (!isRecord(value.error) || typeof value.error.code !== "string") {
    return false;
  }
  if (Object.hasOwn(value.error, "message") && typeof value.error.message !== "string") {
    return false;
  }
  if (Object.hasOwn(value.error, "details") && !isJsonValue(value.error.details)) {
    return false;
  }
  return true;
}

export function isSessionMessage(value: unknown): value is SessionMessage {
  return isRequestMessage(value) || isResponseMessage(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
