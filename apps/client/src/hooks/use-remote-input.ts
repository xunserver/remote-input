import { useCallback, useEffect, useRef, useState } from "react";
import {
  RemoteInputClient,
  WebSocketTransport,
  type RemoteInputError,
  type RemoteInputState,
} from "@remote-copy/sdk";
import { isInputBusy, type HistoryItem } from "@/types/remote-input";
import { buildWsUrl, connectionStorageKey, getConfigFromUrl, getDefaultConnectionConfig } from "@/utils/connection";
import { loadHistory, maxHistoryItems, saveHistory } from "@/utils/history";

type InitialConnection = {
  savedUrl: string | null;
  url: string;
};

function getInitialConnection(): InitialConnection {
  const savedUrl = localStorage.getItem(connectionStorageKey);
  const fallbackUrl = buildWsUrl(getDefaultConnectionConfig());
  const config = getConfigFromUrl(savedUrl || fallbackUrl);

  return {
    savedUrl,
    url: savedUrl || buildWsUrl(config),
  };
}

function getDeviceName(): string {
  return navigator.userAgent.includes("Mobile") ? "移动端浏览器" : "浏览器";
}

export function useRemoteInput() {
  const [initialConnection] = useState(getInitialConnection);
  const [client] = useState(() => new RemoteInputClient({ deviceName: getDeviceName() }));
  const [sdkState, setSdkState] = useState<RemoteInputState>(() => client.getState());
  const activeUrlRef = useRef(initialConnection.url);
  const [connectionUrl, setConnectionUrl] = useState(initialConnection.url);
  const [hasConnectionConfig, setHasConnectionConfig] = useState(Boolean(initialConnection.savedUrl));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);

  const isBusy = isInputBusy(sdkState.currentStatus);

  useEffect(() => client.subscribe(setSdkState), [client]);

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  useEffect(() => {
    const status = sdkState.currentStatus;
    if (!status) {
      return;
    }

    setHistory((items) =>
      items.map((item) =>
        item.id === status.requestId
          ? {
              ...item,
              status: status.status,
              message: status.message || item.message,
              progress: status.progress,
            }
          : item,
      ),
    );
  }, [sdkState.currentStatus]);

  useEffect(() => {
    if (sdkState.connectionState === "connected" || sdkState.connectionState === "ready") {
      localStorage.setItem(connectionStorageKey, activeUrlRef.current);
      setHasConnectionConfig(true);
      setSettingsOpen(false);
    }
  }, [sdkState.connectionState]);

  const connect = useCallback(
    (url: string) => {
      activeUrlRef.current = url;
      setConnectionUrl(url);
      client.connect(new WebSocketTransport(url));
    },
    [client],
  );

  useEffect(() => {
    if (initialConnection.savedUrl) {
      connect(initialConnection.savedUrl);
    }

    return () => client.disconnect();
  }, [client, connect, initialConnection.savedUrl]);

  const sendInput = useCallback(
    (text: string): boolean => {
      if (!text.trim() || isBusy) {
        return false;
      }

      const requestId = client.sendInput(text);
      if (!requestId) {
        return false;
      }

      const queuedMessage = "已发送到服务器，等待处理。";
      setHistory((items) =>
        [
          {
            id: requestId,
            text,
            sentAt: new Date().toISOString(),
            status: "queued" as const,
            message: queuedMessage,
            progress: 5,
          },
          ...items,
        ].slice(0, maxHistoryItems),
      );
      return true;
    },
    [client, isBusy],
  );

  return {
    connectionState: sdkState.connectionState,
    connectionUrl,
    hasConnectionConfig,
    showConnectionDialog: !hasConnectionConfig || settingsOpen,
    deviceName: sdkState.deviceName,
    serverInfo: sdkState.serverInfo,
    clientCount: sdkState.clientCount,
    lastError: getErrorMessage(sdkState.error),
    currentStatus: sdkState.currentStatus,
    history,
    isBusy,
    connect,
    reconnect: () => connect(connectionUrl),
    openConnectionSettings: () => setSettingsOpen(true),
    closeConnectionSettings: () => setSettingsOpen(false),
    sendInput,
    clearHistory: () => setHistory([]),
  };
}

function getErrorMessage(error: RemoteInputError | null): string {
  if (!error) {
    return "";
  }

  if (error.code === "server-error") {
    return error.message || "服务器处理请求失败。";
  }

  if (error.code === "invalid-message") {
    return "服务器返回了无法识别的消息。";
  }

  if (error.code === "transport-send-failed") {
    return "发送失败，请检查连接状态。";
  }

  if (error.code === "transport-connect-failed") {
    return "连接地址无效，请检查 IP 和端口。";
  }

  return "无法连接到服务器，请检查 IP、端口和服务状态。";
}
