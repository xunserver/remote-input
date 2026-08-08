import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import {
  RemoteError,
  Session,
  WebSocketTransport,
} from "@remote-input/protocol";
import { RuntimeStatusStore } from "../dist/status/runtime-status.js";
import {
  protocolWebSocketPath,
  RemoteWebSocketServer,
} from "../dist/websocket/protocol-server.js";
import WebSocket from "ws";

test("sendText responds only after the shared input service completes", async (context) => {
  const started = deferred();
  const release = deferred();
  const accepted = [];
  const fixture = await createFixture(async (source, text) => {
    accepted.push([source, text]);
    started.resolve();
    await release.promise;
  });
  context.after(() => fixture.close());
  const client = await fixture.connectClient();

  const response = client.session.request("sendText", { text: "hello" });
  await started.promise;
  let settled = false;
  void response.finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(accepted, [["websocket", "hello"]]);

  release.resolve();
  assert.equal(await response, null);
});

test("sendKey accepts supported keyboard keys", async (context) => {
  const accepted = [];
  const fixture = await createFixture(async (source, input) => {
    accepted.push([source, input]);
  });
  context.after(() => fixture.close());
  const client = await fixture.connectClient();

  assert.equal(await client.session.request("sendKey", {
    key: "Enter",
    operationId: "key-1",
  }), null);
  assert.deepEqual(accepted, [[
    "websocket",
    { key: "Enter", operationId: "key-1" },
  ]]);
  await assert.rejects(
    client.session.request("sendKey", { key: "Unsupported" }),
    isHandlerError,
  );
});

test("invalid payloads and input failures remain protocol errors", async (context) => {
  const fixture = await createFixture(async (_source, text) => {
    if (text === "fail") throw new Error("private detail");
  });
  context.after(() => fixture.close());
  const client = await fixture.connectClient();

  for (const payload of [
    null,
    "text",
    {},
    { text: 42 },
    { text: "valid", extra: true },
  ]) {
    await assert.rejects(client.session.request("sendText", payload), isHandlerError);
  }
  await assert.rejects(
    client.session.request("sendText", { text: "fail" }),
    isHandlerError,
  );
});

test("connections update runtime status and close cleanly", async (context) => {
  const fixture = await createFixture(async () => {});
  context.after(() => fixture.close());
  const first = await fixture.connectClient();
  const second = await fixture.connectClient();
  assert.equal(fixture.runtimeStatus.snapshot().websocketClients, 2);

  await first.session.close();
  await waitFor(() =>
    fixture.runtimeStatus.snapshot().websocketClients === 1
  );
  await fixture.protocolServer.close();
  assert.equal(fixture.runtimeStatus.snapshot().websocketClients, 0);
  assert.equal(second.transport.state, "closed");
});

test("abnormal disconnect removes a WebSocket client", async (context) => {
  const fixture = await createFixture(async () => {});
  context.after(() => fixture.close());
  const socket = new WebSocket(fixture.url);
  await once(socket, "open");
  assert.equal(fixture.runtimeStatus.snapshot().websocketClients, 1);
  const closed = once(socket, "close");
  socket.terminate();
  await closed;
  await waitFor(() =>
    fixture.runtimeStatus.snapshot().websocketClients === 0
  );
});

async function createFixture(acceptText) {
  const server = http.createServer();
  const runtimeStatus = new RuntimeStatusStore();
  const protocolServer = new RemoteWebSocketServer({
    server,
    acceptInput: (source, command, onStatus) =>
      acceptText(
        source,
        "text" in command ? command.text : command,
        onStatus,
      ),
    runtimeStatus,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `ws://127.0.0.1:${address.port}${protocolWebSocketPath}`;
  const clients = [];
  let closed = false;
  return {
    protocolServer,
    runtimeStatus,
    url,
    async connectClient() {
      const transport = new WebSocketTransport(url);
      const session = new Session(transport);
      await transport.connect();
      const client = { session, transport };
      clients.push(client);
      return client;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(
        clients.map(({ session }) => session.close()),
      );
      await protocolServer.close();
      await closeServer(server);
    },
  };
}

function isHandlerError(error) {
  return error instanceof RemoteError
    && error.remoteError.code === "HANDLER_ERROR"
    && error.remoteError.message === "Remote handler failed.";
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
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
