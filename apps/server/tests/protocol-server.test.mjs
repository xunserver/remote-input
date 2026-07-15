import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  ProtocolResponseError,
  ProtocolSession,
  SocketIoClientTransport,
} from "@remote-copy/protocol/implementations";
import { RemoteSocketIoServer } from "../dist/socket-io/protocol-server.js";

test("Socket.IO server enforces session open, deduplicates operations, and notifies status", async (context) => {
  const operations = new Map();
  let enqueueCount = 0;
  const inputQueue = {
    getStatus(clientId, operationId) {
      const operation = operations.get(operationId);
      return operation?.clientId === clientId ? operation.status : null;
    },
    enqueue(job) {
      enqueueCount += 1;
      const status = {
        operationId: job.operationId,
        revision: 1,
        state: "accepted",
        stage: "queued",
        progress: 15,
        message: "queued",
      };
      operations.set(job.operationId, { clientId: job.client.id, status });
      void job.client.notifyStatus(status);
      return true;
    },
  };

  const server = http.createServer();
  const protocolServer = new RemoteSocketIoServer({
    server,
    config: { host: "127.0.0.1", port: 0, publicDir: "/tmp" },
    inputQueue,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const session = new ProtocolSession(
    new SocketIoClientTransport(`http://127.0.0.1:${address.port}`),
    { heartbeatIntervalMs: 0 },
  );
  context.after(async () => {
    await session.disconnect();
    await secondSession?.disconnect();
    await protocolServer.close();
  });
  let secondSession = null;

  const notifications = [];
  session.subscribe((event) => {
    if (event.type === "notification") notifications.push(event.notification);
  });
  await session.connect();

  await assert.rejects(
    session.request("input.submit", { operationId: "operation-1", text: "fixture" }),
    (error) => error instanceof ProtocolResponseError && error.protocolError.code === "session.required",
  );

  const opened = await session.request("session.open", { clientName: "Fixture" });
  assert.equal(opened.peer.name, "Remote Copy Server");
  assert.ok(opened.capabilities.notifications.includes("operation.status"));

  assert.deepEqual(
    await session.request("input.submit", { operationId: "operation-1", text: "fixture" }),
    { operationId: "operation-1" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.some((item) => item.name === "operation.status"), true);
  assert.equal(enqueueCount, 1);

  await session.request("input.submit", { operationId: "operation-1", text: "fixture" });
  assert.equal(enqueueCount, 1);
  assert.equal((await session.request("operation.get", { operationId: "operation-1" })).revision, 1);

  secondSession = new ProtocolSession(
    new SocketIoClientTransport(`http://127.0.0.1:${address.port}`),
    { heartbeatIntervalMs: 0 },
  );
  await secondSession.connect();
  await secondSession.request("session.open", { clientName: "Other client" });
  await assert.rejects(
    secondSession.request("operation.get", { operationId: "operation-1" }),
    (error) => error instanceof ProtocolResponseError && error.protocolError.code === "operation.not-found",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const peerNotification = notifications.filter((item) => item.name === "session.peers").at(-1);
  assert.equal(peerNotification.body.count, 2);
});
