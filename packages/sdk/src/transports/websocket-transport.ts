import type { InputTransport, TransportEvent, TransportListener } from "./transport.js";

export type WebSocketFactory = (url: string) => WebSocket;

export type WebSocketTransportOptions = {
  createWebSocket?: WebSocketFactory;
};

export class WebSocketTransport implements InputTransport {
  private readonly listeners = new Set<TransportListener>();
  private readonly createWebSocket: WebSocketFactory;
  private socket: WebSocket | null = null;

  constructor(
    readonly url: string,
    options: WebSocketTransportOptions = {},
  ) {
    this.createWebSocket = options.createWebSocket ?? ((target) => new WebSocket(target));
  }

  get isOpen(): boolean {
    return this.socket?.readyState === 1;
  }

  connect(): void {
    this.disconnect();

    const socket = this.createWebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket === socket) {
        this.emit({ type: "open" });
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) {
        this.emit({ type: "message", data: String(event.data) });
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.emit({ type: "close" });
      }
    });
    socket.addEventListener("error", (error) => {
      if (this.socket === socket) {
        this.emit({ type: "error", error });
      }
    });
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  send(data: string): void {
    if (!this.socket || !this.isOpen) {
      throw new Error("Transport is not open.");
    }

    this.socket.send(data);
  }

  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
