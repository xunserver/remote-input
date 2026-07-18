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
      await this.options.inputQueue.enqueue(text);
      return null;
    });

    if (transport.state === "idle" || transport.state === "closed") {
      this.removeClient(client);
    }
  }

  private removeClient(client: RemoteClient): void {
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
