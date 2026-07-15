export const protocolVersion = 1 as const;
export const maxProtocolMessageBytes = 256 * 1024;
export const maxInputBytes = 64 * 1024;
export const maxClientNameLength = 80;
export const maxPendingRequests = 128;

export type ServerInfo = {
  port: number;
  lanAddresses: string[];
};

export type PeerInfo = {
  id: string;
  type: string;
  name: string;
  metadata?: Record<string, unknown>;
};

export type PeerSummary = {
  id: string;
  name: string;
  remoteAddress?: string;
};

export type ProtocolCapabilities = {
  methods: ProtocolMethod[];
  notifications: ProtocolNotificationName[];
};

export type OperationState = "accepted" | "processing" | "succeeded" | "failed";

export type OperationStatus = {
  operationId: string;
  revision: number;
  state: OperationState;
  stage: string;
  progress: number;
  message: string;
};

export type SessionOpenParams = {
  clientName: string;
};

export type SessionOpenResult = {
  protocolVersion: typeof protocolVersion;
  peer: PeerInfo;
  capabilities: ProtocolCapabilities;
};

export type InputSubmitParams = {
  operationId: string;
  text: string;
};

export type InputSubmitResult = {
  operationId: string;
};

export type OperationGetParams = {
  operationId: string;
};

export type ProtocolRequestMap = {
  "session.open": SessionOpenParams;
  "input.submit": InputSubmitParams;
  "operation.get": OperationGetParams;
};

export type ProtocolResultMap = {
  "session.open": SessionOpenResult;
  "input.submit": InputSubmitResult;
  "operation.get": OperationStatus;
};

export type ProtocolMethod = keyof ProtocolRequestMap;

export type SessionPeersNotification = {
  count: number;
  peers: PeerSummary[];
};

export type ProtocolNotificationMap = {
  "operation.status": OperationStatus;
  "session.peers": SessionPeersNotification;
};

export type ProtocolNotificationName = keyof ProtocolNotificationMap;

export type RequestMessage<M extends ProtocolMethod = ProtocolMethod> = M extends ProtocolMethod
  ? {
      v: typeof protocolVersion;
      kind: "request";
      requestId: string;
      method: M;
      body: ProtocolRequestMap[M];
    }
  : never;

export type ProtocolError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type SuccessResponseMessage = {
  v: typeof protocolVersion;
  kind: "response";
  requestId: string;
  ok: true;
  body: unknown;
};

export type ErrorResponseMessage = {
  v: typeof protocolVersion;
  kind: "response";
  requestId: string;
  ok: false;
  error: ProtocolError;
};

export type ResponseMessage = SuccessResponseMessage | ErrorResponseMessage;

export type NotificationMessage<N extends ProtocolNotificationName = ProtocolNotificationName> =
  N extends ProtocolNotificationName
    ? {
        v: typeof protocolVersion;
        kind: "notification";
        name: N;
        body: ProtocolNotificationMap[N];
      }
    : never;

export type PingMessage = {
  v: typeof protocolVersion;
  kind: "ping";
  heartbeatId: string;
};

export type PongMessage = {
  v: typeof protocolVersion;
  kind: "pong";
  heartbeatId: string;
};

export type ProtocolMessage = RequestMessage | ResponseMessage | NotificationMessage | PingMessage | PongMessage;
