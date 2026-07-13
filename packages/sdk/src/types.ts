import type {
  OperationStatus,
  PeerInfo,
  PeerSummary,
  ProtocolCapabilities,
} from "@remote-copy/shared";

export type ConnectionState = "idle" | "connecting" | "connected" | "ready" | "disconnected" | "error";

export type InputSubmission = {
  operationId: string;
};

export type SendInputErrorCode =
  | "input-empty"
  | "transport-not-ready"
  | "input-unsupported"
  | "input-busy"
  | "request-failed";

export type RemoteInputErrorCode =
  | "transport-connect-failed"
  | "transport-error"
  | "invalid-message"
  | "peer-error";

export type RemoteInputError = {
  code: RemoteInputErrorCode;
  message?: string;
};

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

export type RemoteInputClientOptions = {
  clientName?: string;
  createRequestId?: () => string;
  requestTimeoutMs?: number;
};
