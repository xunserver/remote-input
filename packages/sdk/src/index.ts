export { Client } from "./client.js";
export type { ClientOptions } from "./client.js";

export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  RemoteError,
  SDKError,
  isSDKError,
  sdkErrorCodes,
} from "@remote-copy/protocol";
export type {
  DeliveryState,
  JsonValue,
  RequestContext,
  RequestHandler,
  SDKErrorCode,
  Transport,
} from "@remote-copy/protocol";
