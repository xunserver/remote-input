import type {
  IdFactory,
  MessageTransport,
  NotificationMessage,
  OperationStatus,
  PeerInfo,
  PeerSummary,
  ProtocolCapabilities,
} from "@remote-copy/protocol";

export type ConnectionState = "idle" | "connecting" | "connected" | "ready" | "disconnected" | "error";
export type InputSubmission = { operationId: string };

export type SendInputErrorCode =
  | "input-empty"
  | "input-too-large"
  | "transport-not-ready"
  | "input-unsupported"
  | "input-busy"
  | "request-failed";

export type RemoteInputErrorCode =
  | "transport-connect-failed"
  | "transport-error"
  | "invalid-message"
  | "peer-error";

export type RemoteInputError = { code: RemoteInputErrorCode; message?: string };

export type RemoteInputState = {
  connectionState: ConnectionState;
  transportKind: string | null;
  peer: PeerInfo | null;
  capabilities: ProtocolCapabilities | null;
  peers: PeerSummary[];
  currentOperation: OperationStatus | null;
  isSubmitting: boolean;
  error: RemoteInputError | null;
};

export type RemoteInputStateListener = (state: RemoteInputState) => void;
export type OperationStatusListener = (status: OperationStatus) => void;
export type ProtocolNotificationListener = (notification: NotificationMessage) => void;
/** 创建并可异步初始化底层 Transport；例如在返回蓝牙 Transport 前完成设备选择。 */
export type RemoteInputTransportFactory = (url: string) => MessageTransport | Promise<MessageTransport>;

export type RemoteInputClientOptions = {
  clientName?: string;
  createRequestId?: IdFactory;
  createOperationId?: IdFactory;
  createTransport?: RemoteInputTransportFactory;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
};
