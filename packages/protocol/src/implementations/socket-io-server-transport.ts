import { copyBytes, protocolSocketEvent, toUint8Array } from "./socket-io-shared.js";
import type {
  MessageTransport,
  TransportEvent,
  TransportListener,
  TransportState,
} from "../definitions/message-transport.js";

/** Server Transport 需要的最小 Socket.IO Socket 契约。 */
export interface SocketIoServerSocket {
  readonly id: string;
  readonly connected: boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
  disconnect(close?: boolean): this;
}

/**
 * 服务端单连接的 Socket.IO MessageTransport。
 * 每个已接入 Socket 应拥有独立实例，并由上层为其创建独立 ProtocolSession。
 */
export class SocketIoServerTransport implements MessageTransport {
  readonly kind = "socket.io";
  private readonly listeners = new Set<TransportListener>();
  private currentState: TransportState = "idle";
  private started = false;

  /** 将已由 Socket.IO Server 接受的 Socket 包装为 MessageTransport。 */
  constructor(readonly socket: SocketIoServerSocket) {}

  /** 当前 Transport 状态。 */
  get state(): TransportState {
    return this.currentState;
  }

  /** 绑定一次消息监听，并确认传入 Socket 仍处于连接状态。 */
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

  /** 主动关闭该客户端 Socket。 */
  async disconnect(): Promise<void> {
    if (this.socket.connected) {
      this.socket.disconnect(true);
    }
    if (this.currentState !== "disconnected") {
      this.setState("disconnected");
    }
  }

  /** 复制并发送一个完整二进制协议消息。 */
  async send(message: Uint8Array): Promise<void> {
    if (!this.socket.connected || this.currentState !== "connected") {
      throw new Error("Socket.IO server transport is not connected.");
    }
    this.socket.emit(protocolSocketEvent, copyBytes(message));
  }

  /** 订阅连接状态、完整二进制消息和 Transport 错误。 */
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
