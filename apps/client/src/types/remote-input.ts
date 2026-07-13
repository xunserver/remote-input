import type { ConnectionState, OperationState, OperationStatus } from "@remote-copy/sdk";

export type { ConnectionState, OperationStatus } from "@remote-copy/sdk";

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
    case "connected":
      return "已连接";
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
  if (status === "accepted" && stage === "queued") {
    return "排队中";
  }
  if (status === "processing" && stage === "copying") {
    return "写入中";
  }
  if (status === "processing" && stage === "pasting") {
    return "粘贴中";
  }

  switch (status) {
    case "accepted":
      return "已接受";
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
  return status?.state === "accepted" || status?.state === "processing";
}
