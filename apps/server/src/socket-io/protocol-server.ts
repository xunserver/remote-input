import crypto from "node:crypto";
import type http from "node:http";
import {
  protocolVersion,
} from "@remote-copy/protocol";
import {
  ProtocolRequestError,
  ProtocolSession,
  SocketIoServerTransport,
} from "@remote-copy/protocol/implementations";
import { Server, type Socket } from "socket.io";
import type { AppConfig } from "../config.js";
import type { InputQueue } from "../input/inputQueue.js";
import { getLanAddresses } from "../network.js";

type RemoteClient = {
  id: string;
  socket: Socket;
  session: ProtocolSession;
  clientName: string;
  sessionOpen: boolean;
  remoteAddress?: string;
};

export type RemoteSocketIoServerOptions = {
  server: http.Server;
  config: AppConfig;
  inputQueue: InputQueue;
};

export class RemoteSocketIoServer {
  private readonly io: Server;
  private readonly clients = new Map<string, RemoteClient>();
  private readonly serverId = crypto.randomUUID();
  private nextClientNumber = 1;

  constructor(private readonly options: RemoteSocketIoServerOptions) {
    this.io = new Server(options.server, {
      cors: { origin: true },
      maxHttpBufferSize: 256 * 1024,
    });
    this.io.on("connection", (socket) => this.addClient(socket));
  }

  getClientCount(): number {
    return this.clients.size;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.io.close(() => resolve()));
  }

  private addClient(socket: Socket): void {
    const transport = new SocketIoServerTransport(socket);
    const session = new ProtocolSession(transport);
    const client: RemoteClient = {
      id: socket.id,
      socket,
      session,
      clientName: `设备 ${this.nextClientNumber++}`,
      sessionOpen: false,
      remoteAddress: socket.handshake.address,
    };
    this.clients.set(client.id, client);

    session.handleRequest("session.open", ({ clientName }) => {
      client.clientName = clientName;
      client.sessionOpen = true;
      void this.broadcastPeers();
      return {
        protocolVersion,
        peer: {
          id: this.serverId,
          type: "server",
          name: "Remote Copy Server",
          metadata: {
            serverInfo: {
              port: this.options.config.port,
              lanAddresses: getLanAddresses(),
            },
          },
        },
        capabilities: {
          methods: ["input.submit", "operation.get"],
          notifications: ["operation.status", "session.peers"],
        },
      };
    });

    session.handleRequest("input.submit", ({ operationId, text }) => {
      this.requireOpen(client);
      if (!text.trim()) {
        throw new ProtocolRequestError("input.empty", "输入内容为空。");
      }
      const existing = this.options.inputQueue.getStatus(client.id, operationId);
      if (existing) {
        return { operationId };
      }
      const accepted = this.options.inputQueue.enqueue({
        client: {
          id: client.id,
          notifyStatus: (status) => session.notify("operation.status", status),
        },
        operationId,
        text,
      });
      if (!accepted) {
        throw new ProtocolRequestError("input.queue-full", "输入队列已满。", true);
      }
      return { operationId };
    });

    session.handleRequest("operation.get", ({ operationId }) => {
      this.requireOpen(client);
      const status = this.options.inputQueue.getStatus(client.id, operationId);
      if (!status) {
        throw new ProtocolRequestError("operation.not-found", "找不到对应的输入操作。");
      }
      return status;
    });

    session.subscribe((event) => {
      if (event.type === "transport-state" && (event.state === "disconnected" || event.state === "error")) {
        this.removeClient(client.id);
      } else if (event.type === "error") {
        console.error(`Protocol session error for ${client.id}:`, event.error);
      }
    });

    void session.connect().catch((error) => {
      console.error(`Failed to start protocol session for ${client.id}:`, error);
      this.removeClient(client.id);
    });
  }

  private requireOpen(client: RemoteClient): void {
    if (!client.sessionOpen) {
      throw new ProtocolRequestError("session.required", "Open the protocol session first.");
    }
  }

  private removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    void this.broadcastPeers();
  }

  private async broadcastPeers(): Promise<void> {
    const peers = [...this.clients.values()]
      .filter((client) => client.sessionOpen)
      .map((client) => ({
        id: client.id,
        name: client.clientName,
        remoteAddress: client.remoteAddress,
      }));
    await Promise.allSettled(
      [...this.clients.values()]
        .filter((client) => client.sessionOpen)
        .map((client) => client.session.notify("session.peers", { count: peers.length, peers })),
    );
  }
}
