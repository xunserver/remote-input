import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Server } from "socket.io";
import {
  protocolVersion,
} from "../dist/definitions/index.js";
import {
  ProtocolSession,
  SocketIoClientTransport,
  SocketIoServerTransport,
} from "../dist/implementations/index.js";

test("Socket.IO transports carry a real protocol session", async (context) => {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const serverReady = new Promise((resolve, reject) => {
    io.on("connection", (socket) => {
      const session = new ProtocolSession(new SocketIoServerTransport(socket), { heartbeatIntervalMs: 0 });
      session.handleRequest("session.open", ({ clientName }) => ({
        protocolVersion,
        peer: { id: "server-1", type: "fixture", name: `Hello ${clientName}` },
        capabilities: { methods: ["operation.get"], notifications: ["operation.status"] },
      }));
      session.connect().then(() => resolve(session), reject);
    });
  });

  const transport = new SocketIoClientTransport(url);
  const client = new ProtocolSession(transport, { heartbeatIntervalMs: 0 });
  await client.connect();
  await serverReady;
  const result = await client.request("session.open", { clientName: "Browser" });
  assert.equal(result.peer.name, "Hello Browser");
  assert.equal(transport.state, "connected");
  await client.disconnect();
  assert.equal(transport.state, "disconnected");
});
