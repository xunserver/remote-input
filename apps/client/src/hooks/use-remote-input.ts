import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { WebSocketTransport, type TransportState } from "@remote-copy/protocol";
import { Client, isSDKError, sdkErrorCodes } from "@remote-copy/sdk";
import {
  isInputBusy,
  type ConnectionState,
  type HistoryItem,
  type OperationStatus,
  type ServerInfo,
} from "@/types/remote-input";
import {
  buildWebSocketUrl,
  connectionStorageKey,
  getConfigFromUrl,
  getDefaultConnectionConfig,
} from "@/utils/connection";
import { loadHistory, maxHistoryItems, saveHistory } from "@/utils/history";

type InitialConnection = {
  savedUrl: string | null;
  url: string;
};

type Runtime = {
  client: Client;
  connectionEpoch: number;
  generation: number;
  infoAbortController: AbortController | null;
  markedConnected: boolean;
  seenConnected: boolean;
  transport: WebSocketTransport;
  unsubscribe: () => void;
  url: string;
};

type ServerSnapshot = {
  clients: number;
  info: ServerInfo;
};

function getInitialConnection(): InitialConnection {
  const savedUrl = readStoredConnection();
  const fallbackUrl = buildWebSocketUrl(getDefaultConnectionConfig());
  const config = getConfigFromUrl(savedUrl || fallbackUrl);

  return {
    savedUrl,
    url: buildWebSocketUrl(config),
  };
}

export function useRemoteInput() {
  const [initialConnection] = useState(getInitialConnection);
  const [connectionUrl, setConnectionUrl] = useState(initialConnection.url);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [hasConnectionConfig, setHasConnectionConfig] = useState(
    Boolean(initialConnection.savedUrl),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);
  const [currentOperation, setCurrentOperation] =
    useState<OperationStatus | null>(null);
  const [lastError, setLastError] = useState("");
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [clientCount, setClientCount] = useState(0);
  const runtimeRef = useRef<Runtime | null>(null);
  const generationRef = useRef(0);
  const operationInFlightRef = useRef(false);

  const isBusy =
    operationInFlightRef.current || isInputBusy(currentOperation);

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  const refreshServerInfo = useCallback(async (
    runtime: Runtime,
    connectionEpoch: number,
    signal: AbortSignal,
  ) => {
    try {
      const response = await fetch(buildInfoUrl(runtime.url), {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        return;
      }
      const snapshot = parseServerSnapshot(await response.json());
      if (
        !snapshot ||
        signal.aborted ||
        runtimeRef.current !== runtime ||
        generationRef.current !== runtime.generation ||
        runtime.connectionEpoch !== connectionEpoch ||
        runtime.transport.state !== "connected"
      ) {
        return;
      }
      setServerInfo(snapshot.info);
      setClientCount(snapshot.clients);
    } catch {
      // /api/info is presentation metadata; the protocol connection remains usable.
    }
  }, []);

  const markConnected = useCallback(
    (runtime: Runtime, connectionEpoch: number) => {
      if (
        runtimeRef.current !== runtime ||
        generationRef.current !== runtime.generation ||
        runtime.connectionEpoch !== connectionEpoch ||
        runtime.transport.state !== "connected"
      ) {
        return;
      }
      runtime.seenConnected = true;
      if (runtime.markedConnected) {
        return;
      }
      runtime.markedConnected = true;
      setConnectionState("ready");
      setLastError("");
      setHasConnectionConfig(true);
      setSettingsOpen(false);
      storeConnection(runtime.url);
      runtime.infoAbortController?.abort();
      const controller = new AbortController();
      runtime.infoAbortController = controller;
      void refreshServerInfo(runtime, connectionEpoch, controller.signal);
    },
    [refreshServerInfo],
  );

  const startTransport = useCallback(
    (runtime: Runtime) => {
      if (
        runtimeRef.current !== runtime ||
        generationRef.current !== runtime.generation
      ) {
        return;
      }
      setConnectionState("connecting");
      const connectionEpoch = ++runtime.connectionEpoch;
      runtime.markedConnected = false;
      runtime.infoAbortController?.abort();
      runtime.infoAbortController = null;
      setLastError("");
      setServerInfo(null);
      setClientCount(0);
      void runtime.transport
        .connect()
        .then(() => markConnected(runtime, connectionEpoch))
        .catch((error: unknown) => {
          if (
            runtimeRef.current !== runtime ||
            generationRef.current !== runtime.generation ||
            runtime.connectionEpoch !== connectionEpoch
          ) {
            return;
          }
          setConnectionState("error");
          setLastError(formatConnectionError(error));
        });
    },
    [markConnected],
  );

  const connect = useCallback(
    (url: string) => {
      const previous = runtimeRef.current;
      const generation = ++generationRef.current;
      runtimeRef.current = null;
      if (previous) {
        previous.infoAbortController?.abort();
        previous.unsubscribe();
        void previous.client.close().catch(() => undefined);
      }

      setConnectionUrl(url);
      setLastError("");
      setServerInfo(null);
      setClientCount(0);

      try {
        const transport = new WebSocketTransport(url);
        const client = new Client({ transport });
        const runtime: Runtime = {
          client,
          connectionEpoch: 0,
          generation,
          infoAbortController: null,
          markedConnected: false,
          seenConnected: false,
          transport,
          unsubscribe: () => {},
          url,
        };
        runtimeRef.current = runtime;
        runtime.unsubscribe = transport.subscribe((state: TransportState) => {
          if (
            runtimeRef.current !== runtime ||
            generationRef.current !== runtime.generation
          ) {
            return;
          }
          if (state === "connected") {
            markConnected(runtime, runtime.connectionEpoch);
            return;
          }
          if (state === "connecting") {
            setConnectionState("connecting");
            return;
          }
          if (state === "idle") {
            runtime.connectionEpoch += 1;
            runtime.markedConnected = false;
            runtime.infoAbortController?.abort();
            runtime.infoAbortController = null;
            setConnectionState(
              runtime.seenConnected ? "disconnected" : "error",
            );
            if (runtime.seenConnected) {
              setLastError("连接已断开，请重新连接。");
            } else {
              setLastError(
                "无法连接到服务器，请检查 IP、端口和服务状态。",
              );
            }
            setClientCount(0);
            return;
          }
          if (state === "closing" || state === "closed") {
            runtime.connectionEpoch += 1;
            runtime.markedConnected = false;
            runtime.infoAbortController?.abort();
            runtime.infoAbortController = null;
            setConnectionState("disconnected");
            setClientCount(0);
          }
        });
        startTransport(runtime);
      } catch (error) {
        runtimeRef.current = null;
        setConnectionState("error");
        setLastError(formatConnectionError(error));
      }
    },
    [markConnected, startTransport],
  );

  const reconnect = useCallback(() => {
    const runtime = runtimeRef.current;
    if (
      !runtime ||
      runtime.transport.state === "closing" ||
      runtime.transport.state === "closed"
    ) {
      connect(connectionUrl);
      return;
    }
    if (
      runtime.transport.state === "connected" ||
      runtime.transport.state === "connecting"
    ) {
      return;
    }
    startTransport(runtime);
  }, [connect, connectionUrl, startTransport]);

  useEffect(() => {
    if (initialConnection.savedUrl) {
      connect(initialConnection.url);
    }

    return () => {
      const runtime = runtimeRef.current;
      ++generationRef.current;
      runtimeRef.current = null;
      if (runtime) {
        runtime.infoAbortController?.abort();
        runtime.unsubscribe();
        void runtime.client.close().catch(() => undefined);
      }
    };
  }, [connect, initialConnection.savedUrl, initialConnection.url]);

  const sendInput = useCallback(
    async (text: string): Promise<boolean> => {
      const runtime = runtimeRef.current;
      if (
        !text.trim() ||
        operationInFlightRef.current ||
        connectionState !== "ready" ||
        !runtime
      ) {
        return false;
      }

      operationInFlightRef.current = true;
      const operationId = createOperationId();
      const processing: OperationStatus = {
        operationId,
        revision: 0,
        state: "processing",
        stage: "sending",
        progress: 50,
        message: "正在发送，并等待对端完成粘贴。",
      };
      setCurrentOperation(processing);
      setLastError("");
      setHistory((items) =>
        [
          {
            id: operationId,
            text,
            sentAt: new Date().toISOString(),
            status: processing.state,
            stage: processing.stage,
            message: processing.message,
            progress: processing.progress,
          },
          ...items,
        ].slice(0, maxHistoryItems),
      );

      try {
        await runtime.client.sendText(text);
        const succeeded: OperationStatus = {
          ...processing,
          revision: 1,
          state: "succeeded",
          stage: "done",
          progress: 100,
          message: "对端已完成粘贴。",
        };
        setCurrentOperation(succeeded);
        updateHistory(setHistory, succeeded);
        return true;
      } catch (error) {
        const message = formatRequestError(error);
        const failed: OperationStatus = {
          ...processing,
          revision: 1,
          state: "failed",
          stage: "failed",
          progress: 100,
          message,
        };
        setCurrentOperation(failed);
        if (runtimeRef.current === runtime) {
          setLastError(message);
        }
        updateHistory(setHistory, failed);
        return false;
      } finally {
        operationInFlightRef.current = false;
      }
    },
    [connectionState],
  );

  return {
    connectionState,
    connectionUrl,
    hasConnectionConfig,
    showConnectionDialog: !hasConnectionConfig || settingsOpen,
    deviceName: connectionState === "ready" ? "Remote Copy Server" : "",
    serverInfo,
    clientCount,
    lastError,
    currentOperation,
    history,
    isBusy,
    connect,
    reconnect,
    openConnectionSettings: () => setSettingsOpen(true),
    closeConnectionSettings: () => setSettingsOpen(false),
    sendInput,
    clearHistory: () => setHistory([]),
  };
}

function updateHistory(
  setHistory: Dispatch<SetStateAction<HistoryItem[]>>,
  status: OperationStatus,
): void {
  setHistory((items) =>
    items.map((item) =>
      item.id === status.operationId
        ? {
            ...item,
            status: status.state,
            stage: status.stage,
            message: status.message,
            progress: status.progress,
          }
        : item,
    ),
  );
}

function createOperationId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}

function buildInfoUrl(webSocketUrl: string): string {
  const url = new URL(webSocketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/info";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function readStoredConnection(): string | null {
  try {
    return localStorage.getItem(connectionStorageKey);
  } catch {
    return null;
  }
}

function storeConnection(url: string): void {
  try {
    localStorage.setItem(connectionStorageKey, url);
  } catch {
    // Connection persistence is optional and must not alter live state.
  }
}

function parseServerSnapshot(value: unknown): ServerSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.port !== "number" ||
    !Number.isInteger(snapshot.port) ||
    snapshot.port < 1 ||
    snapshot.port > 65535 ||
    typeof snapshot.clients !== "number" ||
    !Number.isInteger(snapshot.clients) ||
    snapshot.clients < 0 ||
    !Array.isArray(snapshot.lanAddresses) ||
    !snapshot.lanAddresses.every((address) => typeof address === "string")
  ) {
    return null;
  }
  return {
    clients: snapshot.clients,
    info: {
      port: snapshot.port,
      lanAddresses: snapshot.lanAddresses,
    },
  };
}

function formatConnectionError(error: unknown): string {
  if (isSDKError(error)) {
    return formatRequestError(error);
  }
  return "无法连接到服务器，请检查 IP、端口和服务状态。";
}

function formatRequestError(error: unknown): string {
  if (!isSDKError(error)) {
    return error instanceof Error && error.message
      ? error.message
      : "请求失败，请稍后重试。";
  }

  switch (error.code) {
    case sdkErrorCodes.requestTimeout:
      if (error.delivery === "not_sent") {
        return "请求在发出前超时，确定未交付；可以安全重试。";
      }
      return error.delivery === "unknown"
        ? "请求超时，无法确认是否交付；重试可能导致重复执行。"
        : "对端已收到请求，但处理响应超时；重试可能导致重复执行。";
    case sdkErrorCodes.transportQueueFull:
      return "发送队列已满，本次请求尚未发送。";
    case sdkErrorCodes.transportNotConnected:
      return "连接尚未建立，请重新连接后再试。";
    case sdkErrorCodes.messageTooLarge:
      return "输入内容超过单条消息大小限制。";
    case sdkErrorCodes.encodeError:
      return "输入无法编码为协议消息。";
    case sdkErrorCodes.deliveryUnconfirmed:
      return "多次发送后仍未收到确认；重试可能导致重复执行。";
    case sdkErrorCodes.transportDisconnected:
      if (error.delivery === "not_sent") {
        return "连接已断开，本次请求确定未交付；可以重连后重试。";
      }
      return error.delivery === "unknown"
        ? "连接已断开，无法确认是否交付；重试可能导致重复执行。"
        : "请求已送达对端，但连接在响应前断开；重试可能导致重复执行。";
    case sdkErrorCodes.sessionClosed:
      if (error.delivery === "not_sent") {
        return "会话已经关闭，本次请求未交付；请重新建立连接。";
      }
      return error.delivery === "unknown"
        ? "会话关闭时无法确认请求是否交付；重试可能导致重复执行。"
        : "请求已送达，但会话在响应前关闭；重试可能导致重复执行。";
    case sdkErrorCodes.remoteError:
      return error.message || "对端处理失败。";
  }
}
