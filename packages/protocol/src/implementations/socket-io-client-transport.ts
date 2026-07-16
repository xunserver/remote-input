import { io, type Socket } from "socket.io-client";
import { copyBytes, protocolSocketEvent, toUint8Array } from "./socket-io-shared.js";
import {
  SocketIoFragmentController,
  type SocketIoTransportOptions,
} from "./socket-io-fragment-controller.js";
import type {
  MessageTransport,
  TransportEvent,
  TransportListener,
  TransportState,
} from "../definitions/message-transport.js";

/** Session 所需的最小 Socket.IO Client Socket 表面，便于测试时替换。 */
export type SocketIoClientSocket = Pick<Socket, "connected" | "connect" | "disconnect" | "on" | "emit">;

/** 每次调用都创建一个全新的、尚未自动连接的 Socket.IO Client Socket。 */
export type SocketIoClientFactory = (url: string) => SocketIoClientSocket;

/** Socket.IO Client Transport 的连接配置和测试注入点。 */
export type SocketIoClientTransportOptions = SocketIoTransportOptions & {
  /** 等待 Socket.IO `connect` 事件的最长时间。 */
  connectTimeoutMs?: number;
  /** 传递给 Socket.IO Client 的自定义服务路径。 */
  path?: string;
  /** 替换 Socket 创建逻辑；每次调用必须返回全新实例。 */
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
  private readonly framingOptions: SocketIoTransportOptions;
  private socket: SocketIoClientSocket | null = null;
  private fragmentController: SocketIoFragmentController | null = null;
  private cancelPendingConnect: ((error: Error) => void) | null = null;
  private lifecycleGeneration = 0;
  private currentState: TransportState = "idle";

  /** 创建指向指定 Socket.IO Server 的 Transport。 */
  constructor(
    readonly url: string,
    options: SocketIoClientTransportOptions = {},
  ) {
    this.connectTimeoutMs = resolveConnectTimeout(options.connectTimeoutMs ?? 10_000);
    this.framingOptions = options;
    this.createSocket = options.createSocket ?? ((target) => io(target, {
      autoConnect: false,
      forceNew: true,
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
    const generation = ++this.lifecycleGeneration;
    this.disconnectCurrent();
    this.setState("connecting");
    if (this.lifecycleGeneration !== generation) {
      throw new Error("Socket.IO transport connection was cancelled.");
    }

    let socket: SocketIoClientSocket;
    try {
      socket = this.createSocket(this.url);
    } catch (error) {
      if (this.lifecycleGeneration !== generation) {
        throw new Error("Socket.IO transport connection was cancelled.");
      }
      this.setState("error");
      throw toError(error);
    }
    if (this.lifecycleGeneration !== generation) {
      socket.disconnect();
      throw new Error("Socket.IO transport connection was cancelled.");
    }
    this.socket = socket;
    let fragmentController: SocketIoFragmentController;
    try {
      fragmentController = new SocketIoFragmentController({
        transmit: (frame) => {
          if (
            this.socket !== socket
            || this.fragmentController !== fragmentController
            || !socket.connected
          ) {
            throw new Error("Socket.IO transport disconnected while sending a frame.");
          }
          socket.emit(protocolSocketEvent, copyBytes(frame));
        },
        deliver: (message) => {
          if (
            this.socket === socket
            && this.fragmentController === fragmentController
            && this.currentState === "connected"
          ) {
            this.emit({ type: "message", message });
          }
        },
        report: (error) => {
          if (this.socket === socket && this.fragmentController === fragmentController) {
            this.emit({ type: "error", error });
          }
        },
        fatal: (error) => this.failCurrentSocket(socket, fragmentController, error),
      }, this.framingOptions);
    } catch (error) {
      this.socket = null;
      socket.disconnect();
      this.setState("error");
      throw toError(error);
    }
    this.fragmentController = fragmentController;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelPendingConnect === cancel) {
          this.cancelPendingConnect = null;
        }
        action();
      };
      const cancel = (error: Error) => finish(() => reject(error));
      timer = setTimeout(() => {
        if (
          this.socket !== socket
          || this.fragmentController !== fragmentController
          || this.lifecycleGeneration !== generation
        ) return;
        this.socket = null;
        this.fragmentController = null;
        fragmentController.close(new Error("Socket.IO transport connection timed out."));
        socket.disconnect();
        this.setState("error");
        finish(() => reject(new Error("Timed out while connecting the Socket.IO transport.")));
      }, this.connectTimeoutMs);
      this.cancelPendingConnect = cancel;

      try {
        socket.on("connect", () => {
          if (
            this.socket !== socket
            || this.fragmentController !== fragmentController
            || this.lifecycleGeneration !== generation
          ) return;
          this.setState("connected");
          finish(resolve);
        });
        socket.on("connect_error", (error: unknown) => {
          if (
            this.socket !== socket
            || this.fragmentController !== fragmentController
            || this.lifecycleGeneration !== generation
          ) return;
          this.socket = null;
          this.fragmentController = null;
          fragmentController.close(toError(error));
          socket.disconnect();
          this.setState("error");
          this.emit({ type: "error", error });
          finish(() => reject(toError(error)));
        });
        socket.on("disconnect", () => {
          if (
            this.socket !== socket
            || this.fragmentController !== fragmentController
            || this.lifecycleGeneration !== generation
          ) return;
          this.socket = null;
          this.fragmentController = null;
          fragmentController.close(new Error("Socket.IO transport disconnected."));
          this.setState("disconnected");
          finish(() => reject(new Error("Socket.IO disconnected before the transport connected.")));
        });
        socket.on(protocolSocketEvent, (value: unknown) => {
          if (
            this.socket !== socket
            || this.fragmentController !== fragmentController
            || this.currentState !== "connected"
          ) return;
          try {
            fragmentController.receive(toUint8Array(value));
          } catch (error) {
            this.failCurrentSocket(socket, fragmentController, toError(error));
          }
        });
        socket.connect();
      } catch (error) {
        const connectionError = toError(error);
        if (
          this.socket === socket
          && this.fragmentController === fragmentController
          && this.lifecycleGeneration === generation
        ) {
          this.socket = null;
          this.fragmentController = null;
          fragmentController.close(connectionError);
          try {
            socket.disconnect();
          } catch {
            // The original setup error remains the connection failure.
          }
          this.setState("error");
          this.emit({ type: "error", error: connectionError });
        }
        finish(() => reject(connectionError));
      }
    });
  }

  /** 断开当前 Socket；允许重复调用。 */
  async disconnect(): Promise<void> {
    ++this.lifecycleGeneration;
    this.disconnectCurrent();
    if (this.currentState !== "idle" && this.currentState !== "disconnected") {
      this.setState("disconnected");
    }
  }

  /** 将完整二进制协议消息分片，并在所有 DATA 帧获得 Transport ACK 后完成。 */
  async send(message: Uint8Array): Promise<void> {
    if (!this.socket?.connected || !this.fragmentController || this.currentState !== "connected") {
      throw new Error("Socket.IO transport is not connected.");
    }
    await this.fragmentController.send(copyBytes(message));
  }

  /** 订阅连接状态、完整二进制消息和 Transport 错误。 */
  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private disconnectCurrent(): void {
    const cancelPendingConnect = this.cancelPendingConnect;
    this.cancelPendingConnect = null;
    cancelPendingConnect?.(new Error("Socket.IO transport connection was cancelled."));
    const socket = this.socket;
    const fragmentController = this.fragmentController;
    this.socket = null;
    this.fragmentController = null;
    fragmentController?.close(new Error("Socket.IO transport disconnected."));
    socket?.disconnect();
  }

  private failCurrentSocket(
    socket: SocketIoClientSocket,
    fragmentController: SocketIoFragmentController,
    error: Error,
  ): void {
    if (this.socket !== socket || this.fragmentController !== fragmentController) return;
    this.socket = null;
    this.fragmentController = null;
    fragmentController.close(error);
    socket.disconnect();
    this.setState("error");
    this.emit({ type: "error", error });
  }

  private setState(state: TransportState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emit({ type: "state", state });
  }

  private emit(event: TransportEvent): void {
    const listenerErrors: unknown[] = [];
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        listenerErrors.push(error);
      }
    }
    if (event.type === "error") return;
    for (const error of listenerErrors) {
      const errorEvent: TransportEvent = { type: "error", error };
      for (const listener of this.listeners) {
        try {
          listener(errorEvent);
        } catch {
          // A listener must not interrupt Transport lifecycle or other listeners.
        }
      }
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Socket.IO transport operation failed.");
}

function resolveConnectTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fff_ffff) {
    throw new Error(
      "Socket.IO client transport option connectTimeoutMs must be a positive integer no greater than 2147483647.",
    );
  }
  return value;
}
