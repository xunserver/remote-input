export type ConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "disconnected"
  | "error";

export type ConnectionMethod = "bluetooth" | "websocket";

export type OperationState = "processing" | "succeeded" | "failed";

export type OperationStatus = {
  operationId: string;
  revision: number;
  state: OperationState;
  stage: string;
  progress: number;
  message: string;
};

export type ServerInfo = {
  port: number;
  lanAddresses: string[];
};

export type ConnectionConfig = {
  host: string;
  port: string;
  secure: boolean;
};

export type HistoryItem = {
  id: string;
  text: string;
  sentAt: string;
  status: OperationState;
  stage: string;
  message: string;
  progress: number;
};

export function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case "connecting":
      return "连接中";
    case "ready":
      return "已就绪";
    case "disconnected":
      return "已断开";
    case "error":
      return "连接错误";
    default:
      return "未连接";
  }
}

export function statusLabel(status?: OperationState, stage?: string): string {
  if (status === "processing" && stage === "sending") {
    return "发送中";
  }

  switch (status) {
    case "processing":
      return "处理中";
    case "succeeded":
      return "完成";
    case "failed":
      return "失败";
    default:
      return "等待输入";
  }
}

export function isInputBusy(status: OperationStatus | null): boolean {
  return status?.state === "processing";
}
