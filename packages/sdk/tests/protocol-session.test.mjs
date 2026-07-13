import assert from "node:assert/strict";
import test from "node:test";
import {
  JsonProtocolCodec,
  ProtocolResponseError,
  ProtocolSession,
  RemoteInputClient,
  SendInputError,
} from "../dist/index.js";

const codec = new JsonProtocolCodec();

class TestTransport {
  kind = "test";
  state = "idle";
  listeners = new Set();
  requests = [];
  onRequest = null;

  async connect() {
    this.state = "connected";
    this.emit({ type: "state", state: "connected" });
  }

  async disconnect() {
    this.state = "disconnected";
    this.emit({ type: "state", state: "disconnected" });
  }

  async send(data) {
    const message = codec.decode(data);
    this.requests.push(message);
    await this.onRequest?.(message, this);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  receive(message) {
    this.emit({ type: "message", message: codec.encode(message) });
  }

  emit(event) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function success(id, body) {
  return { v: 1, kind: "response", id, ok: true, body };
}

function sessionResult() {
  return {
    protocolVersion: 1,
    peer: { id: "peer-1", type: "fixture", name: "Fixture" },
    capabilities: {
      methods: ["input.submit", "operation.get"],
      events: ["operation.status"],
    },
  };
}

test("ProtocolSession correlates responses without leaking request IDs into operation events", async () => {
  const transport = new TestTransport();
  const ids = ["request-open", "request-input"];
  const session = new ProtocolSession(transport, { createRequestId: () => ids.shift() });
  const events = [];
  session.subscribe((event) => events.push(event));
  transport.onRequest = (request, peer) => {
    if (request.method === "session.open") {
      peer.receive(success(request.id, sessionResult()));
      return;
    }

    peer.receive(success(request.id, { operationId: "operation-1" }));
    peer.receive({
      v: 1,
      kind: "event",
      name: "operation.status",
      body: {
        operationId: "operation-1",
        revision: 1,
        state: "accepted",
        stage: "queued",
        progress: 15,
        message: "queued",
      },
    });
  };

  await session.connect("Browser");
  const result = await session.request("input.submit", { text: "hello" });

  assert.deepEqual(result, { operationId: "operation-1" });
  assert.equal(transport.requests[1].id, "request-input");
  assert.equal(events.at(-1).event.body.operationId, "operation-1");
  assert.equal("requestId" in events.at(-1).event.body, false);
});

test("ProtocolSession default request IDs do not require Web Crypto", async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });

  try {
    const transport = new TestTransport();
    const session = new ProtocolSession(transport);
    transport.onRequest = (request, peer) => {
      const body = request.method === "session.open"
        ? sessionResult()
        : { operationId: "operation-1" };
      peer.receive(success(request.id, body));
    };

    await session.connect("Browser");
    await session.request("input.submit", { text: "hello" });

    const requestIds = transport.requests.map((request) => request.id);
    assert.match(requestIds[0], /^request-[0-9a-z]+-[0-9a-z]+$/);
    assert.notEqual(requestIds[0], requestIds[1]);
  } finally {
    if (cryptoDescriptor) {
      Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    } else {
      delete globalThis.crypto;
    }
  }
});

test("ProtocolSession maps downstream failures to ProtocolResponseError", async () => {
  const transport = new TestTransport();
  const ids = ["request-open", "request-input"];
  const session = new ProtocolSession(transport, { createRequestId: () => ids.shift() });
  transport.onRequest = (request, peer) => {
    if (request.method === "session.open") {
      peer.receive(success(request.id, sessionResult()));
      return;
    }

    peer.receive({
      v: 1,
      kind: "response",
      id: request.id,
      ok: false,
      error: { code: "input.rejected", message: "rejected", retryable: false },
    });
  };

  await session.connect("Browser");
  await assert.rejects(
    session.request("input.submit", { text: "hello" }),
    (error) => error instanceof ProtocolResponseError && error.protocolError.code === "input.rejected",
  );
});

test("ProtocolSession times out requests and clears them on disconnect", async () => {
  const transport = new TestTransport();
  const ids = ["request-timeout", "request-disconnect"];
  const session = new ProtocolSession(transport, {
    createRequestId: () => ids.shift(),
    requestTimeoutMs: 5,
  });
  transport.state = "connected";

  await assert.rejects(
    session.request("operation.get", { operationId: "operation-1" }),
    /timed out/,
  );

  const pending = session.request("operation.get", { operationId: "operation-1" });
  await session.disconnect();
  await assert.rejects(pending, /disconnected/);
});

test("ProtocolSession clears session info when the transport disconnects", async () => {
  const transport = new TestTransport();
  const session = new ProtocolSession(transport, { createRequestId: () => "request-open" });
  transport.onRequest = (request, peer) => peer.receive(success(request.id, sessionResult()));

  await session.connect("Browser");
  assert.notEqual(session.info, null);

  transport.state = "disconnected";
  transport.emit({ type: "state", state: "disconnected" });
  assert.equal(session.info, null);
});

test("RemoteInputClient clears session-scoped state after disconnects", async () => {
  for (const disconnectMode of ["explicit", "disconnected", "error"]) {
    const transport = new TestTransport();
    const client = new RemoteInputClient({ createRequestId: () => "request-open" });
    transport.onRequest = (request, peer) => peer.receive(success(request.id, sessionResult()));

    await client.connect(transport);
    transport.receive({
      v: 1,
      kind: "event",
      name: "session.peers",
      body: {
        count: 1,
        peers: [{ id: "peer-1", name: "Fixture" }],
      },
    });

    if (disconnectMode === "explicit") {
      await client.disconnect();
    } else {
      transport.state = disconnectMode;
      transport.emit({ type: "state", state: disconnectMode });
    }

    const state = client.getState();
    assert.equal(state.connectionState, disconnectMode === "explicit" ? "disconnected" : disconnectMode);
    assert.equal(state.peer, null);
    assert.equal(state.capabilities, null);
    assert.deepEqual(state.peers, []);
  }
});

test("RemoteInputClient classifies malformed JSON as an invalid message", async () => {
  const transport = new TestTransport();
  const client = new RemoteInputClient({ createRequestId: () => "request-open" });
  transport.onRequest = (request, peer) => peer.receive(success(request.id, sessionResult()));

  await client.connect(transport);
  transport.emit({
    type: "message",
    message: new TextEncoder().encode("{"),
  });

  assert.equal(client.getState().error?.code, "invalid-message");
});

test("RemoteInputClient caches, subscribes to, and refreshes operation status", async () => {
  const transport = new TestTransport();
  const ids = ["request-open", "request-input", "request-status"];
  const client = new RemoteInputClient({
    clientName: "Browser",
    createRequestId: () => ids.shift(),
  });
  transport.onRequest = (request, peer) => {
    if (request.method === "session.open") {
      peer.receive(success(request.id, sessionResult()));
    } else if (request.method === "input.submit") {
      peer.receive(success(request.id, { operationId: "operation-1" }));
      peer.receive({
        v: 1,
        kind: "event",
        name: "operation.status",
        body: {
          operationId: "operation-1",
          revision: 1,
          state: "accepted",
          stage: "queued",
          progress: 15,
          message: "queued",
        },
      });
    } else {
      peer.receive(success(request.id, {
        operationId: "operation-1",
        revision: 3,
        state: "succeeded",
        stage: "done",
        progress: 100,
        message: "done",
      }));
    }
  };

  await client.connect(transport);
  assert.equal(client.getState().connectionState, "ready");
  assert.deepEqual(await client.sendInput("hello"), { operationId: "operation-1" });
  assert.equal(client.getOperationStatus("operation-1").revision, 1);

  const observed = [];
  client.subscribeOperation("operation-1", (status) => observed.push(status));
  transport.receive({
    v: 1,
    kind: "event",
    name: "operation.status",
    body: {
      operationId: "operation-1",
      revision: 2,
      state: "processing",
      stage: "copying",
      progress: 35,
      message: "copying",
    },
  });
  transport.receive({
    v: 1,
    kind: "event",
    name: "operation.status",
    body: {
      operationId: "operation-1",
      revision: 1,
      state: "accepted",
      stage: "queued",
      progress: 15,
      message: "stale",
    },
  });

  assert.equal(observed.length, 1);
  assert.equal(client.getOperationStatus("operation-1").revision, 2);
  assert.equal((await client.refreshOperationStatus("operation-1")).revision, 3);
  assert.equal(client.getState().currentOperation.state, "succeeded");
});

test("RemoteInputClient exposes typed validation and request errors", async () => {
  const client = new RemoteInputClient();

  await assert.rejects(
    client.sendInput("  "),
    (error) => error instanceof SendInputError && error.code === "input-empty",
  );
  await assert.rejects(
    client.sendInput("hello"),
    (error) => error instanceof SendInputError && error.code === "transport-not-ready",
  );
});

test("RemoteInputClient rejects failed connections", async () => {
  const client = new RemoteInputClient();
  const transport = new TestTransport();
  transport.connect = async () => {
    throw new Error("fixture connection failed");
  };

  await assert.rejects(client.connect(transport), /fixture connection failed/);
  assert.equal(client.getState().connectionState, "error");
  assert.equal(client.getState().error.code, "transport-connect-failed");
});

test("RemoteInputClient returns the newest status when refresh races with an event", async () => {
  const transport = new TestTransport();
  const ids = ["request-open", "request-status"];
  const client = new RemoteInputClient({ createRequestId: () => ids.shift() });
  transport.onRequest = (request, peer) => {
    if (request.method === "session.open") {
      peer.receive(success(request.id, sessionResult()));
      return;
    }

    peer.receive({
      v: 1,
      kind: "event",
      name: "operation.status",
      body: {
        operationId: "operation-1",
        revision: 4,
        state: "succeeded",
        stage: "done",
        progress: 100,
        message: "newest",
      },
    });
    peer.receive(success(request.id, {
      operationId: "operation-1",
      revision: 3,
      state: "processing",
      stage: "copying",
      progress: 70,
      message: "stale",
    }));
  };

  await client.connect(transport);
  const status = await client.refreshOperationStatus("operation-1");
  assert.equal(status.revision, 4);
  assert.equal(client.getOperationStatus("operation-1").revision, 4);
});

test("RemoteInputClient lets a real revision zero replace its synthetic status", async () => {
  const transport = new TestTransport();
  const ids = ["request-open", "request-input"];
  const client = new RemoteInputClient({ createRequestId: () => ids.shift() });
  transport.onRequest = (request, peer) => {
    if (request.method === "session.open") {
      peer.receive(success(request.id, sessionResult()));
    } else {
      peer.receive(success(request.id, { operationId: "operation-1" }));
    }
  };

  await client.connect(transport);
  await client.sendInput("hello");
  transport.receive({
    v: 1,
    kind: "event",
    name: "operation.status",
    body: {
      operationId: "operation-1",
      revision: 0,
      state: "succeeded",
      stage: "done",
      progress: 100,
      message: "real status",
    },
  });

  assert.equal(client.getOperationStatus("operation-1").state, "succeeded");
  assert.equal(client.getOperationStatus("operation-1").message, "real status");
});
