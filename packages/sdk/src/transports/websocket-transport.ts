import type { DuplexTransport, TransportEvent, TransportListener, TransportState } from "./transport.js";

export type WebSocketFactory = (url: string) => WebSocket;

export type WebSocketTransportOptions = {
  createWebSocket?: WebSocketFactory;
  connectTimeoutMs?: number;
};

export class WebSocketTransport implements DuplexTransport {
  readonly kind = "websocket";

  private readonly listeners = new Set<TransportListener>();
  private readonly createWebSocket: WebSocketFactory;
  private readonly connectTimeoutMs: number;
  private socket: WebSocket | null = null;
  private pendingConnect: {
    socket: WebSocket;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private currentState: TransportState = "idle";

  constructor(
    readonly url: string,
    options: WebSocketTransportOptions = {},
  ) {
    this.createWebSocket = options.createWebSocket ?? ((target) => new WebSocket(target));
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  }

  get state(): TransportState {
    return this.currentState;
  }

  connect(): Promise<void> {
    this.closeSocket(new Error("WebSocket connection was replaced."));
    this.setState("connecting");

    return new Promise<void>((resolve, reject) => {
      let socket: WebSocket;

      try {
        socket = this.createWebSocket(this.url);
        socket.binaryType = "arraybuffer";
      } catch (error) {
        this.setState("error");
        reject(toError(error));
        return;
      }

      this.socket = socket;
      let messageQueue = Promise.resolve();
      const timer = setTimeout(() => {
        if (this.pendingConnect?.socket !== socket || socket.readyState === 1) {
          return;
        }

        this.pendingConnect = null;
        this.socket = null;
        socket.close();
        this.setState("error");
        reject(new Error("Timed out while connecting the WebSocket transport."));
      }, this.connectTimeoutMs);
      this.pendingConnect = { socket, reject, timer };

      socket.addEventListener("open", () => {
        if (this.socket !== socket) {
          return;
        }

        clearTimeout(timer);
        this.pendingConnect = null;
        this.setState("connected");
        resolve();
      });

      socket.addEventListener("message", (event) => {
        if (this.socket === socket) {
          messageQueue = messageQueue.then(() => this.handleMessage(socket, event.data));
        }
      });

      socket.addEventListener("close", () => {
        if (this.socket !== socket) {
          return;
        }

        clearTimeout(timer);
        const wasConnecting = this.pendingConnect?.socket === socket;
        if (wasConnecting) {
          this.pendingConnect = null;
        }
        this.socket = null;
        this.setState("disconnected");
        if (wasConnecting) {
          reject(new Error("WebSocket closed before the transport connected."));
        }
      });

      socket.addEventListener("error", (error) => {
        if (this.socket !== socket) {
          return;
        }

        clearTimeout(timer);
        const wasConnecting = this.pendingConnect?.socket === socket;
        if (wasConnecting) {
          this.pendingConnect = null;
          this.socket = null;
          socket.close();
        }
        this.setState("error");
        this.emit({ type: "error", error });
        if (wasConnecting) {
          reject(toError(error));
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.closeSocket(new Error("WebSocket connection was disconnected."));

    if (this.currentState !== "idle" && this.currentState !== "disconnected") {
      this.setState("disconnected");
    }
  }

  async send(message: Uint8Array): Promise<void> {
    if (!this.socket || this.socket.readyState !== 1 || this.currentState !== "connected") {
      throw new Error("WebSocket transport is not connected.");
    }

    const payload = new ArrayBuffer(message.byteLength);
    new Uint8Array(payload).set(message);
    this.socket.send(payload);
  }

  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async handleMessage(socket: WebSocket, data: unknown): Promise<void> {
    try {
      let message: Uint8Array;

      if (typeof data === "string") {
        message = new TextEncoder().encode(data);
      } else if (data instanceof ArrayBuffer) {
        message = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        message = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else if (typeof Blob !== "undefined" && data instanceof Blob) {
        message = new Uint8Array(await data.arrayBuffer());
      } else {
        throw new Error("WebSocket returned an unsupported message type.");
      }

      if (this.socket === socket && this.currentState === "connected") {
        this.emit({ type: "message", message });
      }
    } catch (error) {
      if (this.socket === socket) {
        this.emit({ type: "error", error });
      }
    }
  }

  private closeSocket(reason: Error): void {
    const socket = this.socket;
    const pendingConnect = this.pendingConnect;
    this.socket = null;
    this.pendingConnect = null;

    if (pendingConnect) {
      clearTimeout(pendingConnect.timer);
      pendingConnect.reject(reason);
    }

    socket?.close();
  }

  private setState(state: TransportState): void {
    if (this.currentState === state) {
      return;
    }

    this.currentState = state;
    this.emit({ type: "state", state });
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("WebSocket transport operation failed.");
}
