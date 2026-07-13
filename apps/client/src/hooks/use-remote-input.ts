import { useCallback, useEffect, useRef, useState } from "react";
import {
  RemoteInputClient,
  WebSocketTransport,
  type OperationStatus,
  type PeerInfo,
  type RemoteInputError,
  type RemoteInputState,
  type ServerInfo,
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
  const [client] = useState(() => new RemoteInputClient({ clientName: getDeviceName() }));
  const [sdkState, setSdkState] = useState<RemoteInputState>(() => client.getState());
  const activeUrlRef = useRef(initialConnection.url);
  const [connectionUrl, setConnectionUrl] = useState(initialConnection.url);
  const [hasConnectionConfig, setHasConnectionConfig] = useState(Boolean(initialConnection.savedUrl));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);

  const isBusy = sdkState.isSubmitting || isInputBusy(sdkState.currentOperation);

  useEffect(() => client.subscribe(setSdkState), [client]);

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  useEffect(() => {
    const status = sdkState.currentOperation;
    if (!status) {
      return;
    }

    setHistory((items) =>
      items.map((item) =>
        item.id === status.operationId
          ? {
              ...item,
              status: status.state,
              stage: status.stage,
              message: status.message || item.message,
              progress: status.progress,
            }
          : item,
      ),
    );
  }, [sdkState.currentOperation]);

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
      void client.connect(new WebSocketTransport(url)).catch(() => undefined);
    },
    [client],
  );

  useEffect(() => {
    if (initialConnection.savedUrl) {
      connect(initialConnection.savedUrl);
    }

    return () => {
      void client.disconnect();
    };
  }, [client, connect, initialConnection.savedUrl]);

  const sendInput = useCallback(
    async (text: string): Promise<boolean> => {
      if (!text.trim() || isBusy) {
        return false;
      }

      let operationId: string;

      try {
        ({ operationId } = await client.sendInput(text));
      } catch {
        return false;
      }

      const sdkStatus = client.getOperationStatus(operationId);
      const operationStatus: OperationStatus = sdkStatus?.operationId === operationId
        ? sdkStatus
        : {
            operationId,
            revision: 0,
            state: "accepted",
            stage: "accepted",
            progress: 0,
            message: "下游已接受输入请求。",
          };
      const pendingMessage = operationStatus.message || "下游已接受输入请求。";
      setHistory((items) =>
        [
          {
            id: operationId,
            text,
            sentAt: new Date().toISOString(),
            status: operationStatus.state,
            stage: operationStatus.stage,
            message: pendingMessage,
            progress: operationStatus.progress,
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
    deviceName: sdkState.peer?.name || "",
    serverInfo: getServerInfo(sdkState.peer),
    clientCount: sdkState.peers.length,
    lastError: getErrorMessage(sdkState.error),
    currentOperation: sdkState.currentOperation,
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

  if (error.code === "peer-error") {
    return error.message || "下游拒绝了请求。";
  }

  if (error.code === "invalid-message") {
    return "服务器返回了无法识别的消息。";
  }

  if (error.code === "transport-connect-failed") {
    return "连接地址无效，请检查 IP 和端口。";
  }

  return "无法连接到服务器，请检查 IP、端口和服务状态。";
}

function getServerInfo(peer: PeerInfo | null): ServerInfo | null {
  const value = peer?.metadata?.serverInfo;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const server = value as Record<string, unknown>;
  if (
    typeof server.port !== "number" ||
    !Array.isArray(server.lanAddresses) ||
    !server.lanAddresses.every((address) => typeof address === "string")
  ) {
    return null;
  }

  return {
    port: server.port,
    lanAddresses: server.lanAddresses,
  };
}
