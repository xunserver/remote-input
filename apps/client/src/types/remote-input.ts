import type { ConnectionState, InputStatus } from "@remote-copy/sdk";

export type { ConnectionState, InputStatus } from "@remote-copy/sdk";

export type ConnectionConfig = {
  host: string;
  port: string;
  secure: boolean;
};

export type HistoryItem = {
  id: string;
  text: string;
  sentAt: string;
  status: InputStatus["status"];
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

export function statusLabel(status?: InputStatus["status"]): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "copying":
      return "写入中";
    case "pasting":
      return "粘贴中";
    case "done":
      return "完成";
    case "failed":
      return "失败";
    default:
      return "等待输入";
  }
}

export function isInputBusy(status: InputStatus | null): boolean {
  return status?.status === "queued" || status?.status === "copying" || status?.status === "pasting";
}
