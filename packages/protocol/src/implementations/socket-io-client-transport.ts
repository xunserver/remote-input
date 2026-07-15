import { io, type Socket } from "socket.io-client";
import { copyBytes, protocolSocketEvent, toUint8Array } from "./socket-io-shared.js";
import type {
  MessageTransport,
  TransportEvent,
  TransportListener,
  TransportState,
} from "../definitions/message-transport.js";

/** Session 所需的最小 Socket.IO Client Socket 表面，便于测试时替换。 */
export type SocketIoClientSocket = Pick<Socket, "connected" | "connect" | "disconnect" | "on" | "emit">;

/** 创建尚未自动连接的 Socket.IO Client Socket。 */
export type SocketIoClientFactory = (url: string) => SocketIoClientSocket;

/** Socket.IO Client Transport 的连接配置和测试注入点。 */
export type SocketIoClientTransportOptions = {
  /** 等待 Socket.IO `connect` 事件的最长时间。 */
  connectTimeoutMs?: number;
  /** 传递给 Socket.IO Client 的自定义服务路径。 */
  path?: string;
  /** 替换 Socket 创建逻辑，主要用于测试或宿主环境适配。 */
  createSocket?: SocketIoClientFactory;
};

/**
 * 浏览器/客户端侧 Socket.IO MessageTransport。
 * 只传递二进制协议消息，不解析 JSON、方法或通知语义。
 */
export class SocketIoClientTransport implements MessageTransport {
  readonly kind = "socket.io";
  private readonly listeners = new Set<TransportListener>();
  private readonly connectTimeoutMs: number;
  private readonly createSocket: SocketIoClientFactory;
  private socket: SocketIoClientSocket | null = null;
  private currentState: TransportState = "idle";

  /** 创建指向指定 Socket.IO Server 的 Transport。 */
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

  /** 当前 Transport 状态。 */
  get state(): TransportState {
    return this.currentState;
  }

  /** 创建新 Socket 并等待其连接；不会启用 Socket.IO 自动重连。 */
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

  /** 断开当前 Socket；允许重复调用。 */
  async disconnect(): Promise<void> {
    await this.disconnectCurrent();
    if (this.currentState !== "idle" && this.currentState !== "disconnected") {
      this.setState("disconnected");
    }
  }

  /** 复制并发送一个完整二进制协议消息。 */
  async send(message: Uint8Array): Promise<void> {
    if (!this.socket?.connected || this.currentState !== "connected") {
      throw new Error("Socket.IO transport is not connected.");
    }
    this.socket.emit(protocolSocketEvent, copyBytes(message));
  }

  /** 订阅连接状态、完整二进制消息和 Transport 错误。 */
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
