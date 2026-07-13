import type { ServerInfo, ServerMessage } from "@remote-copy/shared";

export type ConnectionState = "idle" | "connecting" | "connected" | "ready" | "disconnected" | "error";

export type InputStatus = Extract<ServerMessage, { type: "input-status" }>;

export type ConnectedDevice = Extract<ServerMessage, { type: "clients" }>["devices"][number];

export type RemoteInputErrorCode =
  | "transport-connect-failed"
  | "transport-error"
  | "transport-send-failed"
  | "invalid-message"
  | "server-error";

export type RemoteInputError = {
  code: RemoteInputErrorCode;
  message?: string;
};

export type RemoteInputState = {
  connectionState: ConnectionState;
  clientId: string;
  deviceName: string;
  serverInfo: ServerInfo | null;
  clientCount: number;
  devices: ConnectedDevice[];
  currentStatus: InputStatus | null;
  error: RemoteInputError | null;
};

export type RemoteInputStateListener = (state: RemoteInputState) => void;

export type RemoteInputClientOptions = {
  deviceName?: string;
  createRequestId?: () => string;
};
