import crypto from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { ClientMessage, ServerMessage } from "@remote-copy/shared";
import type { AppConfig } from "../config";
import { getLanAddresses } from "../network";
import { parseFrames, sendJsonFrame } from "./frame";

export type RemoteClient = {
  id: string;
  socket: Socket;
  buffer: Buffer;
  deviceName: string;
  remoteAddress?: string;
  send: (message: ServerMessage) => void;
};

export type WebSocketServerOptions = {
  server: http.Server;
  config: AppConfig;
  onInput: (client: RemoteClient, requestId: string, text: string) => void;
};

export class RemoteWebSocketServer {
  private readonly clients = new Map<string, RemoteClient>();
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

    client.send({
      type: "connected",
      clientId: client.id,
      server: this.getServerInfo(),
    });
    this.broadcastClientCount();

    netSocket.on("data", (chunk) => this.handleSocketData(client, chunk));
    netSocket.on("close", () => this.removeClient(client.id));
    netSocket.on("error", () => this.removeClient(client.id));
  }

  private createClient(socket: Socket): RemoteClient {
    return {
      id: crypto.randomUUID(),
      socket,
      buffer: Buffer.alloc(0),
      deviceName: `设备 ${this.nextClientNumber++}`,
      remoteAddress: socket.remoteAddress,
      send: (message) => sendJsonFrame(socket, message),
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
        } else if (frame.opcode === 0x9) {
          client.socket.write(Buffer.from([0x8a, 0x00]));
        } else if ("text" in frame) {
          this.handleMessage(client, frame.text);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "WebSocket 数据解析失败。";
      client.send({ type: "error", message });
    }
  }

  private handleMessage(client: RemoteClient, raw: string): void {
    let message: ClientMessage;

    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      client.send({
        type: "error",
        message: "消息格式不是有效 JSON。",
      });
      return;
    }

    if (message.type === "hello") {
      client.deviceName = String(message.deviceName || client.deviceName).slice(0, 80);
      client.send({
        type: "ready",
        clientId: client.id,
        deviceName: client.deviceName,
        server: this.getServerInfo(),
      });
      this.broadcastClientCount();
      return;
    }

    if (message.type === "input") {
      const text = String(message.text || "");
      const requestId = String(message.requestId || crypto.randomUUID());

      if (!text.trim()) {
        client.send({
          type: "input-status",
          requestId,
          status: "failed",
          progress: 100,
          message: "输入内容为空。",
        });
        return;
      }

      this.options.onInput(client, requestId, text);
    }
  }

  private broadcastClientCount(): void {
    this.broadcast({
      type: "clients",
      count: this.clients.size,
      devices: [...this.clients.values()].map((client) => ({
        id: client.id,
        deviceName: client.deviceName,
        remoteAddress: client.remoteAddress,
      })),
    });
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) {
      client.send(message);
    }
  }

  private removeClient(clientId: string): void {
    this.clients.delete(clientId);
    this.broadcastClientCount();
  }

  private getServerInfo() {
    return {
      port: this.options.config.port,
      lanAddresses: getLanAddresses(),
    };
  }
}
