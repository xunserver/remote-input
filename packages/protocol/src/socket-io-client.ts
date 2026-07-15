import { io, type Socket } from "socket.io-client";
import { copyBytes, protocolSocketEvent, toUint8Array } from "./socket-io-shared.js";
import type { MessageTransport, TransportEvent, TransportListener, TransportState } from "./transport.js";

export type SocketIoClientSocket = Pick<Socket, "connected" | "connect" | "disconnect" | "on" | "emit">;
export type SocketIoClientFactory = (url: string) => SocketIoClientSocket;

export type SocketIoClientTransportOptions = {
  connectTimeoutMs?: number;
  path?: string;
  createSocket?: SocketIoClientFactory;
};

export class SocketIoClientTransport implements MessageTransport {
  readonly kind = "socket.io";
  private readonly listeners = new Set<TransportListener>();
  private readonly connectTimeoutMs: number;
  private readonly createSocket: SocketIoClientFactory;
  private socket: SocketIoClientSocket | null = null;
  private currentState: TransportState = "idle";

  constructor(
    readonly url: string,
    options: SocketIoClientTransportOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.createSocket = options.createSocket ?? ((target) => io(target, {
      autoConnect: false,
      reconnection: false,
      ...(options.path ? { path: options.path } : {}),
    }));
  }

  get state(): TransportState {
    return this.currentState;
  }

  async connect(): Promise<void> {
    await this.disconnectCurrent();
    this.setState("connecting");

    let socket: SocketIoClientSocket;
    try {
      socket = this.createSocket(this.url);
    } catch (error) {
      this.setState("error");
      throw toError(error);
    }
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => {
        if (this.socket !== socket) return;
        this.socket = null;
        socket.disconnect();
        this.setState("error");
        finish(() => reject(new Error("Timed out while connecting the Socket.IO transport.")));
      }, this.connectTimeoutMs);

      socket.on("connect", () => {
        if (this.socket !== socket) return;
        this.setState("connected");
        finish(resolve);
      });
      socket.on("connect_error", (error: unknown) => {
        if (this.socket !== socket) return;
        this.socket = null;
        socket.disconnect();
        this.setState("error");
        this.emit({ type: "error", error });
        finish(() => reject(toError(error)));
      });
      socket.on("disconnect", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.setState("disconnected");
        finish(() => reject(new Error("Socket.IO disconnected before the transport connected.")));
      });
      socket.on(protocolSocketEvent, (value: unknown) => {
        if (this.socket !== socket || this.currentState !== "connected") return;
        try {
          this.emit({ type: "message", message: copyBytes(toUint8Array(value)) });
        } catch (error) {
          this.emit({ type: "error", error });
        }
      });
      socket.connect();
    });
  }

  async disconnect(): Promise<void> {
    await this.disconnectCurrent();
    if (this.currentState !== "idle" && this.currentState !== "disconnected") {
      this.setState("disconnected");
    }
  }

  async send(message: Uint8Array): Promise<void> {
    if (!this.socket?.connected || this.currentState !== "connected") {
      throw new Error("Socket.IO transport is not connected.");
    }
    this.socket.emit(protocolSocketEvent, copyBytes(message));
  }

  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async disconnectCurrent(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    socket?.disconnect();
  }

  private setState(state: TransportState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emit({ type: "state", state });
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Socket.IO transport operation failed.");
}
