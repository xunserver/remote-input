import type { ProtocolClock } from "./clock.js";
import type { DeliveryState, SDKError } from "./errors.js";
import type { JsonValue } from "./json.js";
import type { SessionMessage } from "./messages.js";

/**
 * 传输生命周期。意外断线回到 idle，允许建立新连接；
 * closing/closed 对应显式关闭流程，区别于可恢复的链路中断。
 */
export type TransportState =
  | "idle"
  | "connecting"
  | "connected"
  | "closing"
  | "closed";

export interface TransportSendOptions {
  /** 终止本条尚未完成的传输工作；已经发出的 DATA 无法撤回。 */
  signal?: AbortSignal;
  /** 基于 ProtocolClock 的绝对截止时间，而不是相对超时时长。 */
  deadlineAt?: number;
  /** 交付阶段只允许从 unknown 单向推进到 delivered。 */
  onDeliveryChange?: (
    delivery: Exclude<DeliveryState, "not_sent">,
  ) => void;
}

/**
 * accept 必须同步完成，Transport 仅在其正常返回后才向对端发送 ACK。
 * disconnected 表示可恢复断线；localClosed/peerClosed 表示会话进入关闭终态。
 */
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
  /** Promise 仅在收到对端 Transport ACK 后完成，本地发送成功不等于对端已收到。 */
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
