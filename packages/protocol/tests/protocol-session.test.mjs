import assert from "node:assert/strict";
import test from "node:test";
import {
  JsonMessageCodec,
  ProtocolRequestError,
  ProtocolResponseError,
  ProtocolSession,
} from "../dist/implementations/index.js";

class MemoryTransport {
  kind = "memory";
  state = "idle";
  listeners = new Set();
  peer = null;
  sent = [];

  async connect() {
    this.state = "connected";
    this.emit({ type: "state", state: "connected" });
  }

  async disconnect() {
    this.state = "disconnected";
    this.emit({ type: "state", state: "disconnected" });
  }

  async send(message) {
    if (this.state !== "connected") throw new Error("not connected");
    const copy = new Uint8Array(message);
    this.sent.push(copy);
    queueMicrotask(() => this.peer?.emit({ type: "message", message: copy }));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
}

function createPair() {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

test("ProtocolSession correlates concurrent responses and dispatches notifications", async () => {
  const pair = createPair();
  const ids = ["request-slow", "request-fast"];
  const client = new ProtocolSession(pair.client, { createRequestId: () => ids.shift(), heartbeatIntervalMs: 0 });
  const server = new ProtocolSession(pair.server, { heartbeatIntervalMs: 0 });
  const notifications = [];
  client.subscribe((event) => {
    if (event.type === "notification") notifications.push(event.notification);
  });
  server.handleRequest("operation.get", async ({ operationId }) => {
    if (operationId === "slow") await new Promise((resolve) => setTimeout(resolve, 10));
    return { operationId, revision: 1, state: "succeeded", stage: "done", progress: 100, message: "done" };
  });
  await Promise.all([client.connect(), server.connect()]);

  const slow = client.request("operation.get", { operationId: "slow" });
  const fast = client.request("operation.get", { operationId: "fast" });
  assert.equal((await fast).operationId, "fast");
  assert.equal((await slow).operationId, "slow");

  await server.notify("operation.status", {
    operationId: "fast", revision: 2, state: "succeeded", stage: "done", progress: 100, message: "done",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].body.operationId, "fast");
});

test("ProtocolSession rejects duplicate pending IDs, timeouts, and request errors", async () => {
  const transport = new MemoryTransport();
  const session = new ProtocolSession(transport, {
    createRequestId: () => "same-id",
    requestTimeoutMs: 10,
    heartbeatIntervalMs: 0,
  });
  await session.connect();
  const first = session.request("operation.get", { operationId: "op-1" });
  await assert.rejects(session.request("operation.get", { operationId: "op-2" }), /already pending/);
  await assert.rejects(first, /timed out/);

  const disconnecting = session.request("operation.get", { operationId: "op-3" });
  await session.disconnect();
  await assert.rejects(disconnecting, /disconnected/);

  const pair = createPair();
  const client = new ProtocolSession(pair.client, { heartbeatIntervalMs: 0 });
  const server = new ProtocolSession(pair.server, { heartbeatIntervalMs: 0 });
  server.handleRequest("operation.get", () => {
    throw new ProtocolRequestError("operation.not-found", "missing");
  });
  await Promise.all([client.connect(), server.connect()]);
  await assert.rejects(
    client.request("operation.get", { operationId: "missing" }),
    (error) => error instanceof ProtocolResponseError && error.protocolError.code === "operation.not-found",
  );

  await assert.rejects(
    client.request("session.open", { clientName: "No handler" }),
    (error) => error instanceof ProtocolResponseError && error.protocolError.code === "method.unsupported",
  );
});

test("ProtocolSession answers ping and detects heartbeat timeout", async () => {
  const pair = createPair();
  const client = new ProtocolSession(pair.client, {
    heartbeatIntervalMs: 5,
    heartbeatTimeoutMs: 20,
    createHeartbeatId: () => "heartbeat-1",
  });
  const server = new ProtocolSession(pair.server, { heartbeatIntervalMs: 0 });
  const errors = [];
  client.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });
  await Promise.all([client.connect(), server.connect()]);
  client.startHeartbeat();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(errors.length, 0);
  client.stopHeartbeat();

  pair.server.listeners.clear();
  client.startHeartbeat();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.match(errors.at(-1).message, /heartbeat timed out/);
  assert.equal(pair.client.state, "disconnected");
});

test("ProtocolSession ignores messages delivered by a replaced connection generation", async () => {
  const transport = new MemoryTransport();
  const historicalListeners = [];
  transport.subscribe = (listener) => {
    historicalListeners.push(listener);
    transport.listeners.add(listener);
    return () => transport.listeners.delete(listener);
  };
  const session = new ProtocolSession(transport, { heartbeatIntervalMs: 0 });
  const notifications = [];
  session.subscribe((event) => {
    if (event.type === "notification") notifications.push(event.notification);
  });
  await session.connect();
  await session.connect();

  const codec = new JsonMessageCodec();
  historicalListeners[0]({
    type: "message",
    message: codec.encode({
      v: 1,
      kind: "notification",
      name: "operation.status",
      body: { operationId: "old", revision: 1, state: "succeeded", stage: "done", progress: 100, message: "old" },
    }),
  });
  assert.equal(notifications.length, 0);
});
