import type http from "node:http";
import {
  createConsoleProtocolTracer,
  Session,
  WebSocketTransport,
  type ProtocolTraceLevel,
  type TransportState,
} from "@remote-input/protocol";
import {
  inputStatusMethod,
  parseInputCommand,
  type InputStatus,
} from "@remote-input/sdk";
import { WebSocketServer, type WebSocket } from "ws";
import type { AcceptInput } from "../input/input-service.js";
import type { RuntimeStatusStore } from "../status/runtime-status.js";

export const protocolWebSocketPath = "/ws";

type RemoteClient = {
  session: Session;
  transport: WebSocketTransport;
  unsubscribe: () => void;
};

export type RemoteWebSocketServerOptions = {
  server: http.Server;
  acceptInput: AcceptInput;
  runtimeStatus: RuntimeStatusStore;
  protocolTraceLevel?: ProtocolTraceLevel;
};

/** Creates one protocol session per socket and delegates input to the shared service. */
export class RemoteWebSocketServer {
  private readonly webSocketServer: WebSocketServer;
  private readonly clients = new Set<RemoteClient>();
  private closePromise: Promise<void> | undefined;
  private closing = false;
  private nextClientId = 1;

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

    const clientId = this.nextClientId++;
    const traceLevel = this.options.protocolTraceLevel;
    const onTrace = traceLevel === undefined
      ? undefined
      : createConsoleProtocolTracer(`PC代理/WS连接-${clientId}`);
    const transport = WebSocketTransport.fromSocket(socket, {
      ...(onTrace === undefined ? {} : { onTrace }),
      ...(traceLevel === undefined ? {} : { traceLevel }),
    });
    const session = new Session(transport, {
      ...(onTrace === undefined ? {} : { onTrace }),
      ...(traceLevel === undefined ? {} : { traceLevel }),
    });
    const client: RemoteClient = {
      session,
      transport,
      unsubscribe: () => {},
    };
    this.clients.add(client);
    this.publishClientCount();

    const unsubscribe = transport.subscribe((state: TransportState) => {
      if (state === "idle" || state === "closed") this.removeClient(client);
    });
    client.unsubscribe = unsubscribe;
    if (!this.clients.has(client)) unsubscribe();

    session.registerHandler("sendText", async (payload) => {
      await this.options.acceptInput(
        "websocket",
        parseInputCommand(payload),
        (status) => this.notifyInputStatus(session, status),
      );
      return null;
    });

    session.registerNotificationHandler("sendText", async (payload) => {
      await this.options.acceptInput(
        "websocket",
        parseInputCommand(payload),
        (status) => this.notifyInputStatus(session, status),
      );
    });

    if (transport.state === "idle" || transport.state === "closed") {
      this.removeClient(client);
    }
  }

  private removeClient(client: RemoteClient): void {
    if (!this.clients.delete(client)) return;
    this.publishClientCount();
    client.unsubscribe();
    void client.session.close().catch((error: unknown) => {
      console.error("Failed to close a protocol session:", error);
    });
  }

  private publishClientCount(): void {
    this.options.runtimeStatus.setWebSocketClients(this.clients.size);
  }

  private notifyInputStatus(session: Session, status: InputStatus): void {
    void session.notify(inputStatusMethod, status).catch((error: unknown) => {
      console.error("Failed to notify input status:", error);
    });
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    const webSocketServerClosed = new Promise<void>((resolve, reject) => {
      this.webSocketServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const clients = [...this.clients];
    const sessionsClosed = Promise.allSettled(
      clients.map((client) => client.session.close()),
    ).then(() => {
      for (const client of clients) this.removeClient(client);
    });
    await Promise.all([webSocketServerClosed, sessionsClosed]);
  }
}
