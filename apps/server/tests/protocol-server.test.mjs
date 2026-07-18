import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import {
  RemoteError,
  Session,
  WebSocketTransport,
} from "@remote-copy/protocol";
import {
  InputQueue,
  InputQueueFullError,
} from "../dist/input/inputQueue.js";
import {
  protocolWebSocketPath,
  RemoteWebSocketServer,
} from "../dist/websocket/protocol-server.js";
import WebSocket from "ws";

test("sendText responds only after globally serialized input processing completes", async (context) => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const startedTexts = [];
  const inputQueue = new InputQueue(async (text) => {
    startedTexts.push(text);
    if (text === "first") {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
  });
  const fixture = await createServerFixture(inputQueue);
  context.after(() => fixture.close());

  const firstClient = await fixture.connectClient();
  const secondClient = await fixture.connectClient();
  const firstResponse = firstClient.session.request("sendText", { text: "first" });
  await firstStarted.promise;

  let firstSettled = false;
  void firstResponse.then(
    () => { firstSettled = true; },
    () => { firstSettled = true; },
  );
  const secondResponse = secondClient.session.request("sendText", { text: "second" });
  await nextTurn();

  assert.equal(firstSettled, false, "response must wait for clipboard/paste processing");
  assert.deepEqual(startedTexts, ["first"], "a second client must share the same serial queue");

  releaseFirst.resolve();
  assert.equal(await firstResponse, null);
  assert.equal(await secondResponse, null);
  assert.deepEqual(startedTexts, ["first", "second"]);
});

test("sendText rejects invalid payloads and processor failures as remote errors", async (context) => {
  const inputQueue = new InputQueue(async (text) => {
    if (text === "fail") {
      throw new Error("private processor detail");
    }
  });
  const fixture = await createServerFixture(inputQueue);
  context.after(() => fixture.close());
  const client = await fixture.connectClient();

  for (const payload of [
    null,
    "text",
    {},
    { text: 42 },
    { text: "valid", extra: true },
  ]) {
    await assert.rejects(
      client.session.request("sendText", payload),
      isHandlerError,
    );
  }

  await assert.rejects(
    client.session.request("sendText", { text: "fail" }),
    isHandlerError,
  );
});

test("server tracks clients and closes every accepted WebSocket session", async (context) => {
  const fixture = await createServerFixture(new InputQueue(async () => {}));
  context.after(() => fixture.close());

  assert.equal(fixture.protocolServer.getClientCount(), 0);
  const firstClient = await fixture.connectClient();
  const secondClient = await fixture.connectClient();
  assert.equal(fixture.protocolServer.getClientCount(), 2);

  await firstClient.session.close();
  await waitFor(() => fixture.protocolServer.getClientCount() === 1);

  await fixture.protocolServer.close();
  assert.equal(fixture.protocolServer.getClientCount(), 0);
  assert.equal(secondClient.transport.state, "closed");
});

test("an abnormal WebSocket disconnect removes the accepted server session", async (context) => {
  const fixture = await createServerFixture(new InputQueue(async () => {}));
  context.after(() => fixture.close());

  const socket = new WebSocket(fixture.url);
  await once(socket, "open");
  assert.equal(fixture.protocolServer.getClientCount(), 1);

  const closed = once(socket, "close");
  socket.terminate();
  await closed;
  await waitFor(() => fixture.protocolServer.getClientCount() === 0);
});

test("InputQueue keeps a 100-waiting-job limit and continues after a failed job", async () => {
  const activeStarted = deferred();
  const releaseActive = deferred();
  const processed = [];
  const queue = new InputQueue(async (text) => {
    processed.push(text);
    if (text === "active") {
      activeStarted.resolve();
      await releaseActive.promise;
    }
    if (text === "failure") {
      throw new Error("expected failure");
    }
  });

  const active = queue.enqueue("active");
  await activeStarted.promise;
  const waiting = Array.from({ length: 100 }, (_, index) => queue.enqueue(`waiting-${index}`));
  await assert.rejects(queue.enqueue("overflow"), InputQueueFullError);

  releaseActive.resolve();
  await active;
  await Promise.all(waiting);

  await assert.rejects(queue.enqueue("failure"), /expected failure/);
  await queue.enqueue("after-failure");
  assert.equal(processed.at(-1), "after-failure");
});

async function createServerFixture(inputQueue) {
  const server = http.createServer();
  const protocolServer = new RemoteWebSocketServer({ server, inputQueue });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}${protocolWebSocketPath}`;
  const clients = [];
  let closed = false;

  return {
    protocolServer,
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
      await Promise.allSettled(clients.map(({ session }) => session.close()));
      await protocolServer.close();
      await closeHttpServer(server);
    },
  };
}

function isHandlerError(error) {
  return error instanceof RemoteError
    && error.remoteError.code === "HANDLER_ERROR"
    && error.remoteError.message === "Remote handler failed.";
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

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail("condition was not reached");
}

function closeHttpServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
