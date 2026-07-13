import crypto from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  parseProtocolMessage,
  protocolVersion,
  type OperationStatus,
  type ProtocolMessage,
  type RequestMessage,
} from "@remote-copy/shared";
import type { AppConfig } from "../config";
import { getLanAddresses } from "../network";
import { parseFrames, sendBinaryFrame } from "./frame";

export type RemoteClient = {
  id: string;
  socket: Socket;
  buffer: Buffer;
  clientName: string;
  sessionOpen: boolean;
  remoteAddress?: string;
  send: (message: ProtocolMessage) => void;
};

export type WebSocketServerOptions = {
  server: http.Server;
  config: AppConfig;
  onInput: (client: RemoteClient, operationId: string, text: string) => void;
  getOperationStatus: (client: RemoteClient, operationId: string) => OperationStatus | null;
};

export class RemoteWebSocketServer {
  private readonly clients = new Map<string, RemoteClient>();
  private readonly serverId = crypto.randomUUID();
  private nextClientNumber = 1;

  constructor(private readonly options: WebSocketServerOptions) {
    this.options.server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket));
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex): void {
    const netSocket = socket as Socket;

    if (req.url !== "/ws") {
      netSocket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      netSocket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    netSocket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );

    const client = this.createClient(netSocket);
    this.clients.set(client.id, client);

    netSocket.on("data", (chunk) => this.handleSocketData(client, chunk));
    netSocket.on("close", () => this.removeClient(client.id));
    netSocket.on("error", () => this.removeClient(client.id));
  }

  private createClient(socket: Socket): RemoteClient {
    return {
      id: crypto.randomUUID(),
      socket,
      buffer: Buffer.alloc(0),
      clientName: `设备 ${this.nextClientNumber++}`,
      sessionOpen: false,
      remoteAddress: socket.remoteAddress,
      send: (message) => sendBinaryFrame(socket, Buffer.from(JSON.stringify(message))),
    };
  }

  private handleSocketData(client: RemoteClient, chunk: Buffer | string): void {
    try {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const parsed = parseFrames(Buffer.concat([client.buffer, chunkBuffer]));
      client.buffer = parsed.rest;

      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          client.socket.end();
          return;
        }

        if (frame.opcode === 0x9) {
          client.socket.write(Buffer.from([0x8a, 0x00]));
          continue;
        }

        if ("data" in frame) {
          this.handleMessage(client, frame.data);
        }
      }
    } catch (error) {
      console.error("WebSocket protocol error:", error);
      client.socket.end();
    }
  }

  private handleMessage(client: RemoteClient, data: Uint8Array): void {
    let message: ProtocolMessage;

    try {
      message = parseProtocolMessage(JSON.parse(Buffer.from(data).toString("utf8")) as unknown);
    } catch (error) {
      console.error("Invalid protocol message:", error);
      client.socket.end();
      return;
    }

    if (message.kind !== "request") {
      client.socket.end();
      return;
    }

    this.handleRequest(client, message);
  }

  private handleRequest(client: RemoteClient, request: RequestMessage): void {
    if (request.method === "session.open") {
      client.clientName = request.body.clientName.slice(0, 80);
      client.sessionOpen = true;
      this.sendSuccess(client, request.id, {
        protocolVersion,
        peer: {
          id: this.serverId,
          type: "server",
          name: "Remote Copy Server",
          metadata: {
            serverInfo: this.getServerInfo(),
          },
        },
        capabilities: {
          methods: ["input.submit", "operation.get"],
          events: ["operation.status", "session.peers"],
        },
      });
      this.broadcastPeers();
      return;
    }

    if (!client.sessionOpen) {
      this.sendError(client, request.id, "session.required", "Open the protocol session first.", false);
      return;
    }

    if (request.method === "input.submit") {
      if (!request.body.text.trim()) {
        this.sendError(client, request.id, "input.empty", "输入内容为空。", false);
        return;
      }

      const operationId = crypto.randomUUID();
      this.sendSuccess(client, request.id, { operationId });
      this.options.onInput(client, operationId, request.body.text);
      return;
    }

    const status = this.options.getOperationStatus(client, request.body.operationId);
    if (!status) {
      this.sendError(client, request.id, "operation.not-found", "找不到对应的输入操作。", false);
      return;
    }

    this.sendSuccess(client, request.id, status);
  }

  private sendSuccess(client: RemoteClient, id: string, body: unknown): void {
    client.send({
      v: protocolVersion,
      kind: "response",
      id,
      ok: true,
      body,
    });
  }

  private sendError(client: RemoteClient, id: string, code: string, message: string, retryable: boolean): void {
    client.send({
      v: protocolVersion,
      kind: "response",
      id,
      ok: false,
      error: { code, message, retryable },
    });
  }

  private broadcastPeers(): void {
    const peers = [...this.clients.values()]
      .filter((client) => client.sessionOpen)
      .map((client) => ({
        id: client.id,
        name: client.clientName,
        remoteAddress: client.remoteAddress,
      }));
    const message: ProtocolMessage = {
      v: protocolVersion,
      kind: "event",
      name: "session.peers",
      body: {
        count: peers.length,
        peers,
      },
    };

    for (const client of this.clients.values()) {
      if (client.sessionOpen) {
        client.send(message);
      }
    }
  }

  private removeClient(clientId: string): void {
    this.clients.delete(clientId);
    this.broadcastPeers();
  }

  private getServerInfo() {
    return {
      port: this.options.config.port,
      lanAddresses: getLanAddresses(),
    };
  }
}
