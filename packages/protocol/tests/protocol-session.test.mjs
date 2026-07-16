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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

test("ProtocolSession starts the response timeout after send and accepts an early response", async () => {
  const transport = new MemoryTransport();
  const send = deferred();
  transport.send = async (message) => {
    transport.sent.push(new Uint8Array(message));
    await send.promise;
  };
  const session = new ProtocolSession(transport, {
    createRequestId: () => "request-early",
    requestTimeoutMs: 5,
    heartbeatIntervalMs: 0,
  });
  const errors = [];
  session.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });
  await session.connect();

  const result = session.request("operation.get", { operationId: "op-early" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  transport.emit({
    type: "message",
    message: new JsonMessageCodec().encode({
      v: 1,
      kind: "response",
      requestId: "request-early",
      ok: true,
      body: {
        operationId: "op-early",
        revision: 1,
        state: "succeeded",
        stage: "done",
        progress: 100,
        message: "done",
      },
    }),
  });

  assert.equal((await result).operationId, "op-early");
  assert.equal(errors.length, 0);
  send.resolve();
});

test("ProtocolSession starts request timeout only when a delayed send completes", async () => {
  const transport = new MemoryTransport();
  const send = deferred();
  transport.send = () => send.promise;
  const session = new ProtocolSession(transport, {
    createRequestId: () => "request-delayed-timeout",
    requestTimeoutMs: 10,
    heartbeatIntervalMs: 0,
  });
  await session.connect();

  const result = session.request("operation.get", { operationId: "op-timeout" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  send.resolve();
  await assert.rejects(result, /timed out/);
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

test("ProtocolSession handles a rejected heartbeat disconnect without an unhandled rejection", async () => {
  const transport = new MemoryTransport();
  transport.disconnect = async () => {
    throw new Error("heartbeat disconnect failed");
  };
  const session = new ProtocolSession(transport, {
    heartbeatIntervalMs: 5,
    heartbeatTimeoutMs: 5,
    createHeartbeatId: () => "heartbeat-disconnect-failure",
  });
  const errors = [];
  session.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });
  await session.connect();
  session.startHeartbeat();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(errors.some((error) => /heartbeat timed out/i.test(error.message)), true);
  assert.equal(errors.some((error) => /heartbeat disconnect failed/i.test(error.message)), true);
});

test("ProtocolSession accepts pong before heartbeat send completes", async () => {
  const transport = new MemoryTransport();
  const send = deferred();
  const codec = new JsonMessageCodec();
  transport.send = async (message) => {
    const decoded = codec.decode(message);
    if (decoded.kind === "ping") {
      transport.emit({
        type: "message",
        message: codec.encode({ v: 1, kind: "pong", heartbeatId: decoded.heartbeatId }),
      });
    }
    await send.promise;
  };
  const session = new ProtocolSession(transport, {
    heartbeatIntervalMs: 5,
    heartbeatTimeoutMs: 10,
    createHeartbeatId: () => "heartbeat-early",
  });
  const errors = [];
  session.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });
  await session.connect();
  session.startHeartbeat();

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(errors.length, 0);
  send.resolve();
  session.stopHeartbeat();
});

test("ProtocolSession clears a heartbeat whose send fails", async () => {
  const transport = new MemoryTransport();
  let attempts = 0;
  transport.send = async () => {
    attempts += 1;
    throw new Error("heartbeat send failed");
  };
  const session = new ProtocolSession(transport, {
    heartbeatIntervalMs: 5,
    heartbeatTimeoutMs: 50,
    createHeartbeatId: () => `heartbeat-${attempts + 1}`,
  });
  const errors = [];
  session.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });
  await session.connect();
  session.startHeartbeat();

  await new Promise((resolve) => setTimeout(resolve, 18));
  session.stopHeartbeat();
  assert.ok(attempts >= 2);
  assert.ok(errors.every((error) => error.message === "heartbeat send failed"));
});

test("ProtocolSession reports rejected pong and request response sends", async () => {
  const transport = new MemoryTransport();
  const codec = new JsonMessageCodec();
  const session = new ProtocolSession(transport, { heartbeatIntervalMs: 0 });
  const errors = [];
  session.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });
  session.handleRequest("session.open", () => ({ sessionId: "session-1", protocolVersion: 1 }));
  await session.connect();
  transport.send = async () => {
    throw new Error("response send failed");
  };

  transport.emit({
    type: "message",
    message: codec.encode({ v: 1, kind: "ping", heartbeatId: "ping-1" }),
  });
  transport.emit({
    type: "message",
    message: codec.encode({
      v: 1,
      kind: "request",
      requestId: "incoming-1",
      method: "session.open",
      body: { clientName: "Client" },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors.map((error) => error.message), ["response send failed", "response send failed"]);
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

test("ProtocolSession rejects connect when a state listener synchronously disconnects it", async () => {
  const transport = new MemoryTransport();
  const session = new ProtocolSession(transport, { heartbeatIntervalMs: 0 });
  session.subscribe((event) => {
    if (event.type === "transport-state" && event.state === "connected") {
      void session.disconnect();
    }
  });

  await assert.rejects(session.connect(), /cancelled|replaced/i);
  assert.equal(transport.state, "disconnected");
  assert.equal(transport.listeners.size, 0);
});

test("ProtocolSession does not send an old asynchronous handler response on a new connection", async () => {
  const transport = new MemoryTransport();
  const handlerStarted = deferred();
  const finishHandler = deferred();
  const session = new ProtocolSession(transport, { heartbeatIntervalMs: 0 });
  session.handleRequest("operation.get", async ({ operationId }) => {
    handlerStarted.resolve();
    await finishHandler.promise;
    return {
      operationId,
      revision: 1,
      state: "succeeded",
      stage: "done",
      progress: 100,
      message: "done",
    };
  });
  await session.connect();

  const codec = new JsonMessageCodec();
  transport.emit({
    type: "message",
    message: codec.encode({
      v: 1,
      kind: "request",
      requestId: "request-from-old-connection",
      method: "operation.get",
      body: { operationId: "old-operation" },
    }),
  });
  await handlerStarted.promise;
  await session.connect();
  finishHandler.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transport.sent.length, 0);
});

test("ProtocolSession reconnect clears pending requests and heartbeat timers from the old connection", async () => {
  const transport = new MemoryTransport();
  const session = new ProtocolSession(transport, {
    createRequestId: () => "request-before-reconnect",
    createHeartbeatId: () => "heartbeat-before-reconnect",
    requestTimeoutMs: 100,
    heartbeatIntervalMs: 5,
    heartbeatTimeoutMs: 15,
  });
  const errors = [];
  session.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });
  await session.connect();

  const pending = session.request("operation.get", { operationId: "old-operation" });
  session.startHeartbeat();
  await new Promise((resolve) => setTimeout(resolve, 8));
  await session.connect();

  await assert.rejects(pending, /connection was replaced/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(transport.state, "connected");
  assert.equal(errors.some((error) => /heartbeat timed out/.test(error.message)), false);
});

test("ProtocolSession unsubscribes even when transport disconnect rejects", async () => {
  const transport = new MemoryTransport();
  const session = new ProtocolSession(transport, { heartbeatIntervalMs: 0 });
  await session.connect();
  transport.disconnect = async () => {
    throw new Error("fixture disconnect failed");
  };

  await assert.rejects(session.disconnect(), /fixture disconnect failed/i);
  assert.equal(transport.listeners.size, 0);
});
