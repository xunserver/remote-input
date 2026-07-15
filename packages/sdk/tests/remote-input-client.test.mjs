import assert from "node:assert/strict";
import test from "node:test";
import {
  protocolVersion,
} from "@remote-copy/protocol";
import {
  ProtocolSession,
} from "@remote-copy/protocol/implementations";
import { RemoteInputClient, SendInputError } from "../dist/index.js";

class MemoryTransport {
  kind = "memory";
  state = "idle";
  listeners = new Set();
  peer = null;

  async connect() {
    this.state = "connected";
    this.emit({ type: "state", state: "connected" });
  }
  async disconnect() {
    this.state = "disconnected";
    this.emit({ type: "state", state: "disconnected" });
  }
  async send(message) {
    const copy = new Uint8Array(message);
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

async function createFixture(options = {}) {
  const pair = createPair();
  const server = new ProtocolSession(pair.server, { heartbeatIntervalMs: 0 });
  let submittedOperationId = null;
  server.handleRequest("session.open", () => ({
    protocolVersion,
    peer: { id: "server-1", type: "fixture", name: "Fixture" },
    capabilities: {
      methods: options.methods ?? ["input.submit", "operation.get"],
      notifications: ["operation.status", "session.peers"],
    },
  }));
  server.handleRequest("input.submit", ({ operationId }) => {
    submittedOperationId = operationId;
    return { operationId };
  });
  server.handleRequest("operation.get", ({ operationId }) => ({
    operationId, revision: 3, state: "succeeded", stage: "done", progress: 100, message: "done",
  }));
  await server.connect();

  const client = new RemoteInputClient({
    createTransport: () => pair.client,
    createRequestId: (() => {
      let id = 0;
      return () => `request-${++id}`;
    })(),
    createOperationId: () => "operation-1",
    heartbeatIntervalMs: 0,
  });
  return { client, server, getSubmittedOperationId: () => submittedOperationId };
}

test("RemoteInputClient opens a session, submits a client operation ID, and exposes notifications", async () => {
  const fixture = await createFixture();
  const notifications = [];
  fixture.client.subscribeNotification((notification) => notifications.push(notification));
  await fixture.client.connect("memory://fixture");
  assert.equal(fixture.client.getState().connectionState, "ready");

  assert.deepEqual(await fixture.client.sendInput("hello"), { operationId: "operation-1" });
  assert.equal(fixture.getSubmittedOperationId(), "operation-1");

  await fixture.server.notify("operation.status", {
    operationId: "operation-1", revision: 2, state: "processing", stage: "copying", progress: 35, message: "copying",
  });
  await fixture.server.notify("operation.status", {
    operationId: "operation-1", revision: 1, state: "accepted", stage: "queued", progress: 15, message: "stale",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 2);
  assert.equal(fixture.client.getOperationStatus("operation-1").revision, 2);
  await assert.rejects(
    fixture.client.sendInput("busy"),
    (error) => error instanceof SendInputError && error.code === "input-busy",
  );
  assert.equal((await fixture.client.refreshOperationStatus("operation-1")).revision, 3);
});

test("RemoteInputClient validates calls and clears session state", async () => {
  const client = new RemoteInputClient();
  await assert.rejects(
    client.sendInput("  "),
    (error) => error instanceof SendInputError && error.code === "input-empty",
  );
  await assert.rejects(
    client.sendInput("hello"),
    (error) => error instanceof SendInputError && error.code === "transport-not-ready",
  );

  const fixture = await createFixture();
  await fixture.client.connect("memory://fixture");
  await fixture.client.disconnect();
  assert.equal(fixture.client.getState().connectionState, "disconnected");
  assert.equal(fixture.client.getState().peer, null);

  const unsupported = await createFixture({ methods: ["operation.get"] });
  await unsupported.client.connect("memory://fixture");
  await assert.rejects(
    unsupported.client.sendInput("hello"),
    (error) => error instanceof SendInputError && error.code === "input-unsupported",
  );
});
