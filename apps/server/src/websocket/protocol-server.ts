import type http from "node:http";
import {
  Session,
  WebSocketTransport,
  type JsonValue,
  type TransportState,
} from "@remote-copy/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { InputQueue } from "../input/inputQueue.js";

export const protocolWebSocketPath = "/ws";

type RemoteClient = {
  session: Session;
  transport: WebSocketTransport;
  unsubscribe: () => void;
};

export type RemoteWebSocketServerOptions = {
  server: http.Server;
  inputQueue: InputQueue;
};

/** 为每个 WebSocket 创建独立会话，并通过共享输入队列串行化系统副作用。 */
export class RemoteWebSocketServer {
  private readonly webSocketServer: WebSocketServer;
  private readonly clients = new Set<RemoteClient>();
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(private readonly options: RemoteWebSocketServerOptions) {
    this.webSocketServer = new WebSocketServer({
      server: options.server,
      path: protocolWebSocketPath,
    });
    this.webSocketServer.on("connection", (socket) => this.addClient(socket));
  }

  getClientCount(): number {
    return this.clients.size;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private addClient(socket: WebSocket): void {
    if (this.closing) {
      socket.close();
      return;
    }

    const transport = WebSocketTransport.fromSocket(socket);
    const session = new Session(transport);
    // subscribe() 会同步回放当前状态，回调可能在返回取消函数前移除客户端；
    // 先放入空清理函数，订阅返回后再补偿释放真实监听器。
    const client: RemoteClient = {
      session,
      transport,
      unsubscribe: () => {},
    };
    this.clients.add(client);

    const unsubscribe = transport.subscribe((state: TransportState) => {
      if (state === "idle" || state === "closed") {
        this.removeClient(client);
      }
    });
    client.unsubscribe = unsubscribe;
    if (!this.clients.has(client)) {
      unsubscribe();
    }

    session.registerHandler("sendText", async (payload) => {
      const text = getText(payload);
      // 必须等共享队列完成后再响应，避免把“已入队”误报为对端已完成粘贴。
      await this.options.inputQueue.enqueue(text);
      return null;
    });

    if (transport.state === "idle" || transport.state === "closed") {
      this.removeClient(client);
    }
  }

  private removeClient(client: RemoteClient): void {
    // delete 同时充当幂等门；先退订再关闭 Session，避免状态通知重入清理。
    if (!this.clients.delete(client)) {
      return;
    }
    client.unsubscribe();
    void client.session.close().catch((error: unknown) => {
      console.error("Failed to close a protocol session:", error);
    });
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    // WebSocketServer 的关闭回调会等待现有连接退出，因此必须同时启动会话关闭。
    const webSocketServerClosed = new Promise<void>((resolve, reject) => {
      this.webSocketServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    const clients = [...this.clients];
    // 单个 Session 关闭失败不能阻断其他客户端的退订和移除。
    const sessionsClosed = Promise.allSettled(
      clients.map((client) => client.session.close()),
    ).then(() => {
      for (const client of clients) {
        this.removeClient(client);
      }
    });
    await Promise.all([webSocketServerClosed, sessionsClosed]);
  }
}

function getText(payload: JsonValue): string {
  // 协议输入视为不可信数据，只接受没有额外字段的普通对象。
  if (
    payload === null
    || Array.isArray(payload)
    || typeof payload !== "object"
    || Object.getPrototypeOf(payload) !== Object.prototype
    || Object.keys(payload).length !== 1
    || !Object.hasOwn(payload, "text")
    || typeof payload.text !== "string"
  ) {
    throw new TypeError("sendText payload must be exactly { text: string }.");
  }
  return payload.text;
}
