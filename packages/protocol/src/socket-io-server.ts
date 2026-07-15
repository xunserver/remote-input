import { copyBytes, protocolSocketEvent, toUint8Array } from "./socket-io-shared.js";
import type { MessageTransport, TransportEvent, TransportListener, TransportState } from "./transport.js";

export interface SocketIoServerSocket {
  readonly id: string;
  readonly connected: boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
  disconnect(close?: boolean): this;
}

export class SocketIoServerTransport implements MessageTransport {
  readonly kind = "socket.io";
  private readonly listeners = new Set<TransportListener>();
  private currentState: TransportState = "idle";
  private started = false;

  constructor(readonly socket: SocketIoServerSocket) {}

  get state(): TransportState {
    return this.currentState;
  }

  async connect(): Promise<void> {
    if (!this.socket.connected) {
      this.setState("error");
      throw new Error("Socket.IO server socket is not connected.");
    }
    if (!this.started) {
      this.started = true;
      this.socket.on(protocolSocketEvent, (value: unknown) => {
        if (this.currentState !== "connected") return;
        try {
          this.emit({ type: "message", message: copyBytes(toUint8Array(value)) });
        } catch (error) {
          this.emit({ type: "error", error });
        }
      });
      this.socket.on("disconnect", () => this.setState("disconnected"));
      this.socket.on("error", (error: unknown) => this.emit({ type: "error", error }));
    }
    this.setState("connected");
  }

  async disconnect(): Promise<void> {
    if (this.socket.connected) {
      this.socket.disconnect(true);
    }
    if (this.currentState !== "disconnected") {
      this.setState("disconnected");
    }
  }

  async send(message: Uint8Array): Promise<void> {
    if (!this.socket.connected || this.currentState !== "connected") {
      throw new Error("Socket.IO server transport is not connected.");
    }
    this.socket.emit(protocolSocketEvent, copyBytes(message));
  }

  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
