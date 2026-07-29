import { computed, onMounted, onUnmounted, ref, watch, type Ref } from "vue";
import {
  createConsoleProtocolTracer,
  getWebBluetoothSupport,
  parseProtocolTraceLevel,
  WebBluetoothTransport,
  WebSocketTransport,
  type TransportState,
} from "@remote-input/protocol";
import {
  Client,
  isSDKError,
  sdkErrorCodes,
  type InputControl,
  type InputStatus,
} from "@remote-input/sdk";
import {
  isInputBusy,
  type ConnectionMethod,
  type ConnectionState,
  type HistoryItem,
  type OperationStatus,
  type ServerInfo,
} from "@/types/remote-input";
import {
  buildWebSocketUrl,
  connectionAutoConnectStorageKey,
  connectionMethodStorageKey,
  connectionStorageKey,
  getConfigFromUrl,
  getDefaultConnectionConfig,
} from "@/utils/connection";
import { loadHistory, maxHistoryItems, saveHistory } from "@/utils/history";

type InitialConnection = {
  autoConnect: boolean;
  method: ConnectionMethod;
  savedUrl: string | null;
  url: string;
  webSocketUrl: string;
};

type ConnectionTransport = WebBluetoothTransport | WebSocketTransport;

type Runtime = {
  client: Client;
  // generation 隔离整个 Runtime，connectionEpoch 隔离同一 Runtime 内的连接尝试；
  // 异步回调必须同时匹配两者，才能更新当前界面。
  connectionEpoch: number;
  generation: number;
  infoAbortController: AbortController | null;
  markedConnected: boolean;
  method: ConnectionMethod;
  seenConnected: boolean;
  transport: ConnectionTransport;
  unsubscribe: () => void;
  unsubscribeInputStatus: () => void;
  url: string;
};

type ServerSnapshot = {
  clients: number;
  info: ServerInfo;
};

const bluetoothUrl = "bluetooth://esp32-s3";
const bluetoothStatusTimeoutMs = 15_000;
const protocolTraceLevel = parseProtocolTraceLevel(
  import.meta.env.VITE_PROTOCOL_DEBUG,
);

function getInitialConnection(): InitialConnection {
  const savedUrl = readStoredConnection();
  const savedMethod = readStoredConnectionMethod();
  const fallbackUrl = buildWebSocketUrl(getDefaultConnectionConfig());
  const method = savedMethod ?? (savedUrl ? "websocket" : "bluetooth");
  const webSocketUrl = buildWebSocketUrl(
    getConfigFromUrl(savedUrl || fallbackUrl),
  );

  return {
    autoConnect: readStoredAutoConnect(),
    method,
    savedUrl,
    url: method === "bluetooth" ? bluetoothUrl : webSocketUrl,
    webSocketUrl,
  };
}

/** 统一管理连接生命周期、远端输入请求及其展示状态。 */
export function useRemoteInput() {
  const initialConnection = getInitialConnection();
  const connectionMethod = ref<ConnectionMethod>(initialConnection.method);
  const connectionUrl = ref(initialConnection.url);
  const webSocketUrl = ref(initialConnection.webSocketUrl);
  const connectionState = ref<ConnectionState>("idle");
  const hasConnectionConfig = ref(
    initialConnection.method === "websocket" &&
      Boolean(initialConnection.savedUrl),
  );
  const settingsOpen = ref(false);
  const history = ref<HistoryItem[]>(loadHistory());
  const currentOperation = ref<OperationStatus | null>(null);
  const lastError = ref("");
  const serverInfo = ref<ServerInfo | null>(null);
  const clientCount = ref(0);

  // Runtime 包含 SDK 类实例，保持为普通变量可避免 Vue 对其进行深度代理。
  let runtime: Runtime | null = null;
  let generation = 0;
  let operationEpoch = 0;
  let bluetoothStatusTimer: number | undefined;
  // ref 写入是同步的，可在任何界面更新前拒绝发送和重发入口的重复调用。
  const operationInFlight = ref(false);

  const isBusy = computed(
    () => operationInFlight.value || isInputBusy(currentOperation.value),
  );
  const showConnectionDialog = computed(
    () => !hasConnectionConfig.value || settingsOpen.value,
  );
  const deviceName = computed(() => {
    if (connectionState.value !== "ready") {
      return "";
    }
    return connectionMethod.value === "bluetooth"
      ? "Remote Input ESP32-S3"
      : "Remote Input Server";
  });

  watch(history, saveHistory, { immediate: true, flush: "sync" });

  async function refreshServerInfo(
    targetRuntime: Runtime,
    connectionEpoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const response = await fetch(buildInfoUrl(targetRuntime.url), {
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
        runtime !== targetRuntime ||
        generation !== targetRuntime.generation ||
        targetRuntime.connectionEpoch !== connectionEpoch ||
        targetRuntime.transport.state !== "connected"
      ) {
        return;
      }
      serverInfo.value = snapshot.info;
      clientCount.value = snapshot.clients;
    } catch {
      // /api/info 只用于 WebSocket 服务端信息展示，失败不影响协议连接。
    }
  }

  function markConnected(
    targetRuntime: Runtime,
    connectionEpoch: number,
  ): void {
    if (
      runtime !== targetRuntime ||
      generation !== targetRuntime.generation ||
      targetRuntime.connectionEpoch !== connectionEpoch ||
      targetRuntime.transport.state !== "connected"
    ) {
      return;
    }
    targetRuntime.seenConnected = true;
    // 状态订阅和 connect().then 都可能报告成功，每个连接代次只执行一次后续副作用。
    if (targetRuntime.markedConnected) {
      return;
    }
    targetRuntime.markedConnected = true;
    connectionState.value = "ready";
    lastError.value = "";
    hasConnectionConfig.value = true;
    settingsOpen.value = false;
    serverInfo.value = null;
    clientCount.value = 0;
    storeConnectionMethod(targetRuntime.method);
    storeAutoConnect(true);
    if (targetRuntime.method === "websocket") {
      storeConnection(targetRuntime.url);
      const controller = new AbortController();
      targetRuntime.infoAbortController = controller;
      void refreshServerInfo(targetRuntime, connectionEpoch, controller.signal);
    }
  }

  function startTransport(targetRuntime: Runtime): void {
    if (
      runtime !== targetRuntime ||
      generation !== targetRuntime.generation
    ) {
      return;
    }
    connectionState.value = "connecting";
    // 推进代次，使同一 Runtime 上一次 connect 或元数据请求的迟到结果失效。
    const connectionEpoch = ++targetRuntime.connectionEpoch;
    targetRuntime.markedConnected = false;
    targetRuntime.infoAbortController?.abort();
    targetRuntime.infoAbortController = null;
    lastError.value = "";
    serverInfo.value = null;
    clientCount.value = 0;
    void targetRuntime.transport
      .connect()
      .then(() => markConnected(targetRuntime, connectionEpoch))
      .catch((error: unknown) => {
        if (
          runtime !== targetRuntime ||
          generation !== targetRuntime.generation ||
          targetRuntime.connectionEpoch !== connectionEpoch
        ) {
          return;
        }
        connectionState.value = "error";
        lastError.value = formatConnectionError(error, targetRuntime.method);
      });
  }

  function connect(method: ConnectionMethod, requestedUrl?: string): void {
    if (method === "bluetooth") {
      const support = getWebBluetoothSupport();
      if (!support.supported) {
        lastError.value = support.reason === "insecure_context"
          ? "网页蓝牙需要 HTTPS 或 localhost 安全上下文。"
          : "当前浏览器不支持 Web Bluetooth，请使用 Android Chrome 或支持该功能的桌面 Chromium 浏览器。";
        return;
      }
    }

    cancelCurrentOperation("连接已切换，之前的发送已取消。");
    const previous = runtime;
    const runtimeGeneration = ++generation;
    // 先废弃旧 Runtime 再异步关闭，确保旧监听器和 Promise 无法回写新连接。
    runtime = null;
    if (previous) {
      previous.infoAbortController?.abort();
      previous.unsubscribe();
      previous.unsubscribeInputStatus();
      void previous.client.close().catch(() => undefined);
    }

    const url = method === "bluetooth"
      ? bluetoothUrl
      : requestedUrl || webSocketUrl.value;
    connectionMethod.value = method;
    connectionUrl.value = url;
    if (method === "websocket") {
      webSocketUrl.value = url;
    }
    lastError.value = "";
    serverInfo.value = null;
    clientCount.value = 0;

    try {
      const onTrace =
        method === "websocket" && protocolTraceLevel !== undefined
          ? createConsoleProtocolTracer(`客户端/运行-${runtimeGeneration}`)
          : undefined;
      const transport: ConnectionTransport = method === "bluetooth"
        ? new WebBluetoothTransport()
        : new WebSocketTransport(url, {
            ...(onTrace === undefined ? {} : { onTrace }),
            ...(protocolTraceLevel === undefined
              ? {}
              : { traceLevel: protocolTraceLevel }),
          });
      const client = new Client({
        transport,
        ...(onTrace === undefined ? {} : { onTrace }),
        ...(protocolTraceLevel === undefined
          ? {}
          : { traceLevel: protocolTraceLevel }),
      });
      const nextRuntime: Runtime = {
        client,
        connectionEpoch: 0,
        generation: runtimeGeneration,
        infoAbortController: null,
        markedConnected: false,
        method,
        seenConnected: false,
        transport,
        unsubscribe: () => {},
        unsubscribeInputStatus: () => {},
        url,
      };
      // subscribe() 会同步回放当前状态，必须先发布 Runtime 引用。
      runtime = nextRuntime;
      nextRuntime.unsubscribeInputStatus = client.onInputStatus((status) => {
        if (runtime === nextRuntime && generation === nextRuntime.generation) {
          applyInputStatus(status);
        }
      });
      nextRuntime.unsubscribe = transport.subscribe((state: TransportState) => {
        if (
          runtime !== nextRuntime ||
          generation !== nextRuntime.generation
        ) {
          return;
        }
        if (state === "connected") {
          markConnected(nextRuntime, nextRuntime.connectionEpoch);
          return;
        }
        if (state === "connecting") {
          connectionState.value = "connecting";
          return;
        }
        // 其余状态均终结当前连接尝试，先推进代次以屏蔽迟到回调。
        if (state === "idle") {
          nextRuntime.connectionEpoch += 1;
          nextRuntime.markedConnected = false;
          nextRuntime.infoAbortController?.abort();
          nextRuntime.infoAbortController = null;
          connectionState.value = nextRuntime.seenConnected
            ? "disconnected"
            : "error";
          lastError.value = nextRuntime.seenConnected
            ? "连接已断开，请重新连接。"
            : initialConnectionError(nextRuntime.method);
          clientCount.value = 0;
          return;
        }
        if (state === "closing" || state === "closed") {
          nextRuntime.connectionEpoch += 1;
          nextRuntime.markedConnected = false;
          nextRuntime.infoAbortController?.abort();
          nextRuntime.infoAbortController = null;
          connectionState.value = "disconnected";
          clientCount.value = 0;
        }
      });
      startTransport(nextRuntime);
    } catch (error) {
      runtime = null;
      connectionState.value = "error";
      lastError.value = formatConnectionError(error, method);
    }
  }

  function reconnect(): void {
    if (connectionState.value === "connecting") {
      return;
    }
    // 用户主动重连时总是关闭旧 Session 并创建新 Runtime，避免旧请求、监听器或
    // 传输队列跨越连接代次；蓝牙重连也因此会重新触发设备选择。
    connect(connectionMethod.value, connectionUrl.value);
  }

  function disconnect(): void {
    cancelCurrentOperation("连接已主动断开，未完成的发送已取消。");
    disposeRuntime();
    connectionState.value = "disconnected";
    lastError.value = "";
    serverInfo.value = null;
    clientCount.value = 0;
    storeAutoConnect(false);
  }

  function resetConnection(): void {
    cancelCurrentOperation("连接已重置，未完成的发送已取消。");
    disposeRuntime();
    clearStoredConnection();
    const fallbackUrl = buildWebSocketUrl(getDefaultConnectionConfig());
    connectionMethod.value = "bluetooth";
    connectionUrl.value = bluetoothUrl;
    webSocketUrl.value = fallbackUrl;
    connectionState.value = "idle";
    hasConnectionConfig.value = false;
    settingsOpen.value = false;
    lastError.value = "";
    serverInfo.value = null;
    clientCount.value = 0;
  }

  onMounted(() => {
    if (
      initialConnection.autoConnect &&
      (initialConnection.method === "bluetooth" ||
        (initialConnection.method === "websocket" &&
          initialConnection.savedUrl))
    ) {
      connect(initialConnection.method, initialConnection.url);
    }
  });

  async function sendInput(
    text: string,
    control: InputControl = {
      paste: true,
      restoreClipboard: false,
    },
  ): Promise<boolean> {
    const targetRuntime = runtime;
    if (
      !text.trim() ||
      operationInFlight.value ||
      connectionState.value !== "ready" ||
      !targetRuntime
    ) {
      return false;
    }

    operationInFlight.value = true;
    clearBluetoothStatusTimeout();
    const targetOperationEpoch = ++operationEpoch;
    const operationId = createOperationId();
    const processing: OperationStatus = {
      operationId,
      revision: 0,
      state: "processing",
      stage: "sending",
      progress: 50,
      message: targetRuntime.method === "bluetooth"
        ? "正在通过蓝牙发送控制与输入报文。"
        : "正在发送，并等待接收端处理。",
    };
    currentOperation.value = processing;
    lastError.value = "";
    history.value = [
      {
        id: operationId,
        text,
        sentAt: new Date().toISOString(),
        status: processing.state,
        stage: processing.stage,
        message: processing.message,
        progress: processing.progress,
      },
      ...history.value,
    ].slice(0, maxHistoryItems);

    try {
      if (targetRuntime.method === "bluetooth") {
        await targetRuntime.client.sendTextUnconfirmed(text, {
          operationId,
          ...control,
        });
        if (operationEpoch !== targetOperationEpoch) {
          return false;
        }
        const operation = currentOperation.value;
        if (
          !operation ||
          operation.operationId !== operationId ||
          operation.state === "failed"
        ) {
          return false;
        }
        if (operation.state === "succeeded") {
          clearBluetoothStatusTimeout();
          return true;
        }
        if (
          operation.state === "processing" &&
          operation.revision === 0
        ) {
          const waiting: OperationStatus = {
            ...processing,
            revision: 1,
            stage: "sent",
            progress: 20,
            message: "已发送，等待接收端状态通知。",
          };
          currentOperation.value = waiting;
          updateHistory(history, waiting);
        }
        armBluetoothStatusTimeout(operationId);
        return true;
      } else {
        await targetRuntime.client.sendText(text, {
          operationId,
          ...control,
        });
      }
      const succeeded: OperationStatus = {
        ...processing,
        revision: 1,
        state: "succeeded",
        stage: "done",
        progress: 100,
        message: control.paste
          ? "接收端已完成输入。"
          : "接收端已复制到剪贴板。",
      };
      if (operationEpoch === targetOperationEpoch) {
        currentOperation.value = succeeded;
        updateHistory(history, succeeded);
        return true;
      }
      return false;
    } catch (error) {
      clearBluetoothStatusTimeout();
      const message = formatRequestError(error);
      const failed: OperationStatus = {
        ...processing,
        revision: 1,
        state: "failed",
        stage: "failed",
        progress: 100,
        message,
      };
      if (operationEpoch !== targetOperationEpoch) {
        return false;
      }
      currentOperation.value = failed;
      // 历史项仍需结算，但旧 Runtime 的失败不能污染新连接的错误提示。
      if (runtime === targetRuntime) {
        lastError.value = message;
      }
      updateHistory(history, failed);
      return false;
    } finally {
      if (operationEpoch === targetOperationEpoch) {
        operationInFlight.value = false;
      }
    }
  }

  onUnmounted(() => {
    disposeRuntime();
  });

  return {
    connectionMethod,
    connectionState,
    connectionUrl,
    webSocketUrl,
    hasConnectionConfig,
    showConnectionDialog,
    deviceName,
    serverInfo,
    clientCount,
    lastError,
    currentOperation,
    history,
    isBusy,
    connect,
    reconnect,
    disconnect,
    resetConnection,
    openConnectionSettings: () => {
      settingsOpen.value = true;
    },
    closeConnectionSettings: () => {
      settingsOpen.value = false;
    },
    sendInput,
    clearHistory: () => {
      history.value = [];
    },
  };

  function disposeRuntime(): void {
    clearBluetoothStatusTimeout();
    const targetRuntime = runtime;
    // 先废弃 generation 与 Runtime，屏蔽关闭过程中同步或迟到的回调。
    ++generation;
    runtime = null;
    if (!targetRuntime) {
      return;
    }
    targetRuntime.infoAbortController?.abort();
    targetRuntime.unsubscribe();
    targetRuntime.unsubscribeInputStatus();
    void targetRuntime.client.close().catch(() => undefined);
  }

  function cancelCurrentOperation(message: string): void {
    clearBluetoothStatusTimeout();
    ++operationEpoch;
    operationInFlight.value = false;
    const operation = currentOperation.value;
    if (!operation || operation.state !== "processing") {
      return;
    }
    const failed: OperationStatus = {
      ...operation,
      revision: operation.revision + 1,
      state: "failed",
      stage: "failed",
      progress: 100,
      message,
    };
    currentOperation.value = failed;
    updateHistory(history, failed);
  }

  function applyInputStatus(status: InputStatus): void {
    const operation = currentOperation.value;
    if (
      !operation ||
      operation.operationId !== status.operationId ||
      operation.state !== "processing"
    ) {
      return;
    }
    const next: OperationStatus = {
      ...operation,
      revision: operation.revision + 1,
      state: status.stage === "failed"
        ? "failed"
        : status.stage === "succeeded"
          ? "succeeded"
          : "processing",
      stage: status.stage,
      progress: status.progress,
      message: status.message,
    };
    currentOperation.value = next;
    updateHistory(history, next);
    if (next.state === "processing") {
      armBluetoothStatusTimeout(next.operationId);
    } else {
      clearBluetoothStatusTimeout();
    }
    if (next.state === "failed") {
      lastError.value = next.message;
    }
  }

  function armBluetoothStatusTimeout(operationId: string): void {
    clearBluetoothStatusTimeout();
    bluetoothStatusTimer = window.setTimeout(() => {
      bluetoothStatusTimer = undefined;
      const operation = currentOperation.value;
      if (
        !operation ||
        operation.operationId !== operationId ||
        operation.state !== "processing"
      ) {
        return;
      }
      const failed: OperationStatus = {
        ...operation,
        revision: operation.revision + 1,
        state: "failed",
        stage: "failed",
        progress: 100,
        message:
          "等待接收端状态超时，请确认 PC Agent 或 WebHID 接收页正在运行。",
      };
      currentOperation.value = failed;
      lastError.value = failed.message;
      updateHistory(history, failed);
    }, bluetoothStatusTimeoutMs);
  }

  function clearBluetoothStatusTimeout(): void {
    if (bluetoothStatusTimer === undefined) {
      return;
    }
    window.clearTimeout(bluetoothStatusTimer);
    bluetoothStatusTimer = undefined;
  }
}

function updateHistory(
  history: Ref<HistoryItem[]>,
  status: OperationStatus,
): void {
  history.value = history.value.map((item) =>
    item.id === status.operationId
      ? {
          ...item,
          status: status.state,
          stage: status.stage,
          message: status.message,
          progress: status.progress,
        }
      : item,
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

function readStoredConnectionMethod(): ConnectionMethod | null {
  try {
    const value = localStorage.getItem(connectionMethodStorageKey);
    return value === "bluetooth" || value === "websocket" ? value : null;
  } catch {
    return null;
  }
}

function readStoredAutoConnect(): boolean {
  try {
    // 缺少该键表示旧版本保存的 WS 配置，保持原有自动恢复行为。
    return localStorage.getItem(connectionAutoConnectStorageKey) !== "false";
  } catch {
    return true;
  }
}

function storeConnection(url: string): void {
  try {
    localStorage.setItem(connectionStorageKey, url);
  } catch {
    // 连接配置持久化是可选能力，失败不能改变实时连接状态。
  }
}

function storeConnectionMethod(method: ConnectionMethod): void {
  try {
    localStorage.setItem(connectionMethodStorageKey, method);
  } catch {
    // 连接方式持久化是可选能力，失败不能改变实时连接状态。
  }
}

function storeAutoConnect(enabled: boolean): void {
  try {
    localStorage.setItem(
      connectionAutoConnectStorageKey,
      enabled ? "true" : "false",
    );
  } catch {
    // 自动连接偏好持久化失败时不影响当前连接。
  }
}

function clearStoredConnection(): void {
  try {
    localStorage.removeItem(connectionStorageKey);
    localStorage.removeItem(connectionMethodStorageKey);
    localStorage.removeItem(connectionAutoConnectStorageKey);
  } catch {
    // 清理失败时仍完成内存中的连接重置。
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

function initialConnectionError(method: ConnectionMethod): string {
  return method === "bluetooth"
    ? "无法连接到 ESP32-S3，请确认蓝牙已开启并重新选择设备。"
    : "无法连接到服务器，请检查 IP、端口和服务状态。";
}

function formatConnectionError(
  error: unknown,
  method: ConnectionMethod,
): string {
  if (isSDKError(error)) {
    if (
      method === "bluetooth" &&
      error.code === sdkErrorCodes.transportNotConnected
    ) {
      return initialConnectionError(method);
    }
    return formatRequestError(error);
  }
  return initialConnectionError(method);
}

function formatRequestError(error: unknown): string {
  if (!isSDKError(error)) {
    return error instanceof Error && error.message
      ? error.message
      : "请求失败，请稍后重试。";
  }

  // 只有 not_sent 能保证对端未执行；其余交付状态必须保留重复执行风险。
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
