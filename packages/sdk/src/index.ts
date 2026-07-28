export { Client } from "./client.js";
export type { ClientOptions } from "./client.js";
export {
  createSendTextPayload,
  inputStatusMethod,
  parseInputCommand,
  parseInputStatus,
} from "./input.js";
export type {
  InputCommand,
  InputControl,
  InputStatus,
  InputStatusListener,
  InputStatusStage,
  SendTextOptions,
} from "./input.js";

export {
  CHUNK_PAYLOAD_BYTES,
  createConsoleProtocolTracer,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CHUNKS_PER_TRANSFER,
  MAX_IN_FLIGHT_CHUNKS,
  parseProtocolTraceLevel,
  RemoteError,
  SDKError,
  isSDKError,
  sdkErrorCodes,
} from "@remote-input/protocol";
export type {
  DeliveryState,
  JsonValue,
  NotificationContext,
  NotificationHandler,
  ProtocolTraceDetails,
  ProtocolTraceEvent,
  ProtocolTraceLevel,
  ProtocolTraceListener,
  ProtocolTraceValue,
  RequestContext,
  RequestHandler,
  SDKErrorCode,
  Transport,
} from "@remote-input/protocol";
