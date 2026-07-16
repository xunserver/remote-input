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

/** Server Transport 需要的最小 Socket.IO Socket 契约。 */
export interface SocketIoServerSocket {
  readonly id: string;
  readonly connected: boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
  disconnect(close?: boolean): this;
}

export type SocketIoServerTransportOptions = SocketIoTransportOptions;

/**
 * 服务端单连接的 Socket.IO MessageTransport。
 * 每个已接入 Socket 应拥有独立实例，并由上层为其创建独立 ProtocolSession。
 */
export class SocketIoServerTransport implements MessageTransport {
  readonly kind = "socket.io";
  private readonly listeners = new Set<TransportListener>();
  private currentState: TransportState = "idle";
  private started = false;
  private fragmentController: SocketIoFragmentController | null = null;

  /** 将已由 Socket.IO Server 接受的 Socket 包装为 MessageTransport。 */
  constructor(
    readonly socket: SocketIoServerSocket,
    private readonly options: SocketIoServerTransportOptions = {},
  ) {}

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
    if (this.currentState === "connected" && this.fragmentController) {
      return;
    }
    this.fragmentController?.close(new Error("Socket.IO server transport connection was replaced."));
    let fragmentController: SocketIoFragmentController;
    try {
      fragmentController = new SocketIoFragmentController({
        transmit: (frame) => {
          if (
            this.fragmentController !== fragmentController
            || !this.socket.connected
            || this.currentState !== "connected"
          ) {
            throw new Error("Socket.IO server transport disconnected while sending a frame.");
          }
          this.socket.emit(protocolSocketEvent, copyBytes(frame));
        },
        deliver: (message) => {
          if (this.fragmentController === fragmentController && this.currentState === "connected") {
            this.emit({ type: "message", message });
          }
        },
        report: (error) => {
          if (this.fragmentController === fragmentController) {
            this.emit({ type: "error", error });
          }
        },
        fatal: (error) => this.failCurrentController(fragmentController, error),
      }, this.options);
    } catch (error) {
      this.fragmentController = null;
      this.setState("error");
      throw toError(error);
    }
    this.fragmentController = fragmentController;
    if (!this.started) {
      this.started = true;
      this.socket.on(protocolSocketEvent, (value: unknown) => {
        if (this.currentState !== "connected") return;
        const currentController = this.fragmentController;
        if (!currentController) return;
        try {
          currentController.receive(toUint8Array(value));
        } catch (error) {
          this.failCurrentController(currentController, toError(error));
        }
      });
      this.socket.on("disconnect", () => {
        this.fragmentController?.close(new Error("Socket.IO server transport disconnected."));
        this.fragmentController = null;
        this.setState("disconnected");
      });
      this.socket.on("error", (error: unknown) => {
        const currentController = this.fragmentController;
        if (currentController) {
          this.failCurrentController(currentController, toError(error));
        } else {
          this.emit({ type: "error", error });
        }
      });
    }
    this.setState("connected");
    if (
      this.currentState !== "connected"
      || this.fragmentController !== fragmentController
      || !this.socket.connected
    ) {
      throw new Error("Socket.IO server transport connection was cancelled.");
    }
  }

  /** 主动关闭该客户端 Socket。 */
  async disconnect(): Promise<void> {
    this.fragmentController?.close(new Error("Socket.IO server transport disconnected."));
    this.fragmentController = null;
    if (this.socket.connected) {
      this.socket.disconnect(true);
    }
    if (this.currentState !== "disconnected") {
      this.setState("disconnected");
    }
  }

  /** 将完整二进制协议消息分片，并在所有 DATA 帧获得 Transport ACK 后完成。 */
  async send(message: Uint8Array): Promise<void> {
    if (!this.socket.connected || !this.fragmentController || this.currentState !== "connected") {
      throw new Error("Socket.IO server transport is not connected.");
    }
    await this.fragmentController.send(copyBytes(message));
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

  private failCurrentController(fragmentController: SocketIoFragmentController, error: Error): void {
    if (this.fragmentController !== fragmentController) return;
    this.fragmentController = null;
    fragmentController.close(error);
    this.setState("error");
    this.emit({ type: "error", error });
    if (this.socket.connected) {
      this.socket.disconnect(true);
    }
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
  return error instanceof Error ? error : new Error("Socket.IO server transport operation failed.");
}
