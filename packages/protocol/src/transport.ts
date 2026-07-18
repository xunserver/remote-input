import type { ProtocolClock } from "./clock.js";
import type { DeliveryState, SDKError } from "./errors.js";
import type { JsonValue } from "./json.js";
import type { SessionMessage } from "./messages.js";

export type TransportState =
  | "idle"
  | "connecting"
  | "connected"
  | "closing"
  | "closed";

export interface TransportSendOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  onDeliveryChange?: (
    delivery: Exclude<DeliveryState, "not_sent">,
  ) => void;
}

export interface TransportReceiver {
  accept(message: JsonValue): void;
  disconnected(error: SDKError): void;
  localClosed(): void;
  peerClosed(): void;
}

export interface Transport {
  bind(receiver: TransportReceiver): void;
  unbind(receiver: TransportReceiver): void;
  connect(): Promise<void>;
  send(
    message: SessionMessage,
    options?: TransportSendOptions,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface ProtocolRuntimeOptions {
  clock?: ProtocolClock;
  onDiagnostic?: (message: string, cause?: unknown) => void;
}
