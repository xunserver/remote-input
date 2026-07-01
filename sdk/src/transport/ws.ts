import { RemoteInputClient } from "../device";
import { getErrorMessage, RemoteInputError } from "../errors";
import { decodeStatusFrame } from "../protocol";
import type { RemoteWebSocket, RemoteWebSocketConstructor } from "../types";
import type {
  RemoteInputDisconnectListener,
  RemoteInputStatusListener,
  RemoteInputTransport,
} from "./types";

export const DEFAULT_WS_URL = "ws://192.168.4.1/ws";
const DEFAULT_INITIAL_STATUS_TIMEOUT_MS = 5000;

export interface ConnectWsOptions {
  initialStatusTimeoutMs?: number;
}

function toDataView(data: unknown): DataView {
  if (data instanceof DataView) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new DataView(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new RemoteInputError("INVALID_STATUS_FRAME", "Invalid status frame");
}

function cloneDataView(view: DataView): DataView {
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return new DataView(bytes.buffer);
}

export class WsTransport implements RemoteInputTransport {
  readonly kind = "ws";
  readonly socket: RemoteWebSocket;
  private readonly WebSocketCtor: RemoteWebSocketConstructor;
  private statusListeners = new Set<RemoteInputStatusListener>();
  private disconnectListeners = new Set<RemoteInputDisconnectListener>();
  private latestStatus: DataView | null = null;
  private isConnected = true;

  constructor(socket: RemoteWebSocket, WebSocketCtor: RemoteWebSocketConstructor, initialStatus: DataView) {
    this.socket = socket;
    this.WebSocketCtor = WebSocketCtor;
    this.latestStatus = cloneDataView(initialStatus);
    this.handleMessage = this.handleMessage.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.socket.addEventListener("message", this.handleMessage);
    this.socket.addEventListener("close", this.handleClose);
  }

  get connected(): boolean {
    return this.isConnected && this.socket.readyState === this.WebSocketCtor.OPEN;
  }

  writeControl(frame: Uint8Array): Promise<void> {
    return this.writeFrame(frame);
  }

  writeData(frame: Uint8Array): Promise<void> {
    return this.writeFrame(frame);
  }

  async readStatus(): Promise<DataView> {
    if (!this.connected) {
      throw new RemoteInputError("NOT_CONNECTED", "Device is not connected");
    }
    if (!this.latestStatus) {
      throw new RemoteInputError("WS_STATUS_UNAVAILABLE", "WebSocket status is not available");
    }
    return cloneDataView(this.latestStatus);
  }

  onStatus(listener: RemoteInputStatusListener): void {
    this.statusListeners.add(listener);
  }

  offStatus(listener: RemoteInputStatusListener): void {
    this.statusListeners.delete(listener);
  }

  onDisconnect(listener: RemoteInputDisconnectListener): void {
    this.disconnectListeners.add(listener);
  }

  offDisconnect(listener: RemoteInputDisconnectListener): void {
    this.disconnectListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("close", this.handleClose);
    if (this.socket.readyState === this.WebSocketCtor.OPEN) {
      this.socket.close();
    }
  }

  private writeFrame(frame: Uint8Array): Promise<void> {
    if (!this.connected) {
      return Promise.reject(new RemoteInputError("NOT_CONNECTED", "Device is not connected"));
    }
    try {
      this.socket.send(frame);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(new RemoteInputError("WS_WRITE_FAILED", getErrorMessage(error, "WebSocket write failed"), error));
    }
  }

  private handleMessage(event: MessageEvent): void {
    let status: DataView;
    try {
      status = cloneDataView(toDataView(event.data));
    } catch {
      status = new DataView(new ArrayBuffer(0));
    }
    this.latestStatus = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private handleClose(): void {
    this.isConnected = false;
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}

export async function connectWs(url = DEFAULT_WS_URL, options: ConnectWsOptions = {}): Promise<RemoteInputClient> {
  const WebSocketCtor = globalThis.WebSocket as RemoteWebSocketConstructor | undefined;
  if (!WebSocketCtor) {
    throw new RemoteInputError("WEB_SOCKET_UNSUPPORTED", "WebSocket is not available");
  }

  return new Promise((resolve, reject) => {
    let socket: RemoteWebSocket;
    try {
      socket = new WebSocketCtor(url);
    } catch (error) {
      reject(new RemoteInputError("WEB_SOCKET_CONNECT_FAILED", getErrorMessage(error, "WebSocket connection failed"), error));
      return;
    }

    socket.binaryType = "arraybuffer";
    let settled = false;
    let initialStatusTimer: ReturnType<typeof setTimeout> | undefined;
    const initialStatusTimeoutMs = options.initialStatusTimeoutMs ?? DEFAULT_INITIAL_STATUS_TIMEOUT_MS;

    const cleanupBeforeTransport = (): void => {
      if (initialStatusTimer !== undefined) {
        clearTimeout(initialStatusTimer);
        initialStatusTimer = undefined;
      }
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", handleInitialMessage);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
    };

    const fail = (code: string, message: string, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanupBeforeTransport();
      try {
        socket.close();
      } catch {
        // Ignore cleanup errors while reporting the original connection failure.
      }
      reject(new RemoteInputError(code, message, cause));
    };

    const handleOpen = (): void => {
      socket.addEventListener("message", handleInitialMessage);
      initialStatusTimer = setTimeout(() => {
        fail("WEB_SOCKET_CONNECT_FAILED", "Timed out waiting for initial WebSocket status");
      }, initialStatusTimeoutMs);
    };

    const handleInitialMessage = (event: MessageEvent): void => {
      let initialStatus: DataView;
      try {
        initialStatus = toDataView(event.data);
        decodeStatusFrame(initialStatus);
      } catch (error) {
        fail("INVALID_STATUS_FRAME", getErrorMessage(error, "Invalid status frame"), error);
        return;
      }
      settled = true;
      cleanupBeforeTransport();
      resolve(new RemoteInputClient(new WsTransport(socket, WebSocketCtor, initialStatus)));
    };

    const handleError = (event: Event): void => {
      fail("WEB_SOCKET_CONNECT_FAILED", "WebSocket connection failed", event);
    };

    const handleClose = (): void => {
      fail("WEB_SOCKET_CONNECT_FAILED", "WebSocket closed before initial status");
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });
}
