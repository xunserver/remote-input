import assert from "node:assert/strict";
import test from "node:test";

import {
  ACK_TIMEOUT_MS,
  SDKError,
  Session,
  WebSocketTransport,
  sdkErrorCodes,
} from "../dist/index.js";
import {
  FakeClock,
  FakeWebSocketPair,
  socketFactoryFrom,
} from "../dist/testing.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observe(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
}

async function drain(clock, turns = 20) {
  for (let turn = 0; turn < turns; turn += 1) {
    clock.flushMicrotasks();
    await Promise.resolve();
  }
  clock.flushMicrotasks();
}

async function closeAll(clock, ...sessions) {
  const closing = sessions.map((session) => session.close());
  await drain(clock);
  await Promise.all(closing);
}

function parseFrame(raw) {
  return JSON.parse(raw);
}

function assertSDKError(result, code, delivery) {
  assert.equal(result.status, "rejected");
  assert.ok(result.error instanceof SDKError);
  assert.equal(result.error.code, code);
  assert.equal(result.error.delivery, delivery);
}

test("two Sessions can originate requestId 1 simultaneously over one full-duplex link", async () => {
  const clock = new FakeClock();
  const pair = new FakeWebSocketPair({ clock });
  const leftTransport = WebSocketTransport.fromSocket(pair.client, { clock });
  const rightTransport = WebSocketTransport.fromSocket(pair.server, { clock });
  const left = new Session(leftTransport, { clock });
  const right = new Session(rightTransport, { clock });

  left.registerHandler("right-to-left", (payload, context) => ({
    handledBy: "left",
    requestId: context.requestId,
    payload,
  }));
  right.registerHandler("left-to-right", (payload, context) => ({
    handledBy: "right",
    requestId: context.requestId,
    payload,
  }));

  const fromLeft = left.request("left-to-right", { value: "L" });
  const fromRight = right.request("right-to-left", { value: "R" });
  await drain(clock);

  assert.deepEqual(await fromLeft, {
    handledBy: "right",
    requestId: 1,
    payload: { value: "L" },
  });
  assert.deepEqual(await fromRight, {
    handledBy: "left",
    requestId: 1,
    payload: { value: "R" },
  });
  await closeAll(clock, left, right);
  assert.equal(clock.pendingTimerCount, 0);
});

test("lost Request and Response ACKs never duplicate Handler execution or request settlement", async () => {
  const clock = new FakeClock();
  const pair = new FakeWebSocketPair({ clock });
  const leftTransport = WebSocketTransport.fromSocket(pair.client, { clock });
  const rightTransport = WebSocketTransport.fromSocket(pair.server, { clock });
  const left = new Session(leftTransport, { clock });
  const right = new Session(rightTransport, { clock });
  let handlerCalls = 0;
  let settlements = 0;

  right.registerHandler("work", () => {
    handlerCalls += 1;
    return { done: true };
  });
  pair.dropNext({ kind: "ACK", direction: "server-to-client" });
  pair.dropNext({ kind: "ACK", direction: "client-to-server" });

  const result = left.request("work", null);
  void result.then(
    () => { settlements += 1; },
    () => { settlements += 1; },
  );
  await drain(clock);
  assert.deepEqual(await result, { done: true });
  assert.equal(handlerCalls, 1);
  assert.equal(settlements, 1);

  clock.advanceBy(ACK_TIMEOUT_MS);
  await drain(clock);
  const responseFrames = pair.server.sent.filter(
    (raw) => parseFrame(raw).kind === "DATA",
  );
  assert.equal(responseFrames.length, 2);
  assert.equal(responseFrames[0], responseFrames[1]);
  assert.equal(handlerCalls, 1);
  assert.equal(settlements, 1);
  assert.equal(clock.pendingTimerCount, 0);

  await closeAll(clock, left, right);
});

test("request timeout never cancels an already-running remote Handler", async () => {
  const clock = new FakeClock();
  const pair = new FakeWebSocketPair({ clock });
  const leftTransport = WebSocketTransport.fromSocket(pair.client, { clock });
  const rightTransport = WebSocketTransport.fromSocket(pair.server, { clock });
  const left = new Session(leftTransport, { clock, requestTimeoutMs: 10 });
  const right = new Session(rightTransport, { clock });
  const handler = deferred();
  let handlerStarted = false;
  let handlerCompleted = false;

  right.registerHandler("slow", async () => {
    handlerStarted = true;
    await handler.promise;
    handlerCompleted = true;
    return "late result";
  });

  const result = observe(left.request("slow", null));
  await drain(clock);
  assert.equal(handlerStarted, true);

  clock.advanceBy(10);
  await drain(clock);
  assertSDKError(await result, sdkErrorCodes.requestTimeout, "delivered");

  handler.resolve();
  await drain(clock);
  assert.equal(handlerCompleted, true);
  assert.equal(
    pair.server.sent.filter((raw) => parseFrame(raw).kind === "DATA").length,
    1,
    "the remote Session still sends the late Response",
  );
  assert.equal(clock.pendingTimerCount, 0);

  await closeAll(clock, left, right);
});

test("disconnect reports delivered, unknown, and not_sent precisely, then reconnects without replay", async () => {
  const clock = new FakeClock();
  const firstPair = new FakeWebSocketPair({ clock });
  const secondPair = new FakeWebSocketPair({ clock });
  const leftTransport = new WebSocketTransport("ws://test/ws", {
    clock,
    socketFactory: socketFactoryFrom(
      firstPair.client,
      secondPair.client,
    ),
  });
  const left = new Session(leftTransport, { clock });
  const rightTransport1 = WebSocketTransport.fromSocket(firstPair.server, {
    clock,
  });
  const right1 = new Session(rightTransport1, { clock });
  const held = deferred();
  let heldHandlerStarted = false;

  right1.registerHandler("hold", async () => {
    heldHandlerStarted = true;
    return held.promise;
  });
  await leftTransport.connect();

  const delivered = observe(left.request("hold", null));
  await drain(clock);
  assert.equal(heldHandlerStarted, true);

  firstPair.setInterceptor((packet) => {
    if (
      packet.kind === "ACK" &&
      packet.direction === "server-to-client" &&
      parseFrame(packet.data).transferId === 2
    ) {
      return { drop: true };
    }
    return undefined;
  });
  const unknown = observe(left.request("missing-active", null));
  const notSent = observe(left.request("missing-queued", null));
  await drain(clock);

  firstPair.disconnect();
  await drain(clock);
  const [deliveredResult, unknownResult, notSentResult] = await Promise.all([
    delivered,
    unknown,
    notSent,
  ]);
  assertSDKError(
    deliveredResult,
    sdkErrorCodes.transportDisconnected,
    "delivered",
  );
  assertSDKError(
    unknownResult,
    sdkErrorCodes.transportDisconnected,
    "unknown",
  );
  assertSDKError(
    notSentResult,
    sdkErrorCodes.transportDisconnected,
    "not_sent",
  );

  held.resolve("old response");
  await drain(clock);
  assert.equal(
    firstPair.server.sent.filter(
      (raw) => parseFrame(raw).kind === "DATA",
    ).length,
    0,
  );

  const rightTransport2 = WebSocketTransport.fromSocket(secondPair.server, {
    clock,
  });
  const right2 = new Session(rightTransport2, { clock });
  right2.registerHandler("echo", (payload) => payload);
  await leftTransport.connect();

  const afterReconnect = left.request("echo", { fresh: true });
  await drain(clock);
  assert.deepEqual(await afterReconnect, { fresh: true });
  const newData = secondPair.client.sent.find(
    (raw) => parseFrame(raw).kind === "DATA",
  );
  assert.ok(newData);
  assert.equal(parseFrame(newData).transferId, 1);
  assert.equal(
    JSON.parse(parseFrame(newData).payload).requestId,
    4,
  );

  await closeAll(clock, left, right1, right2);
  assert.equal(clock.pendingTimerCount, 0);
});

test("external Transport close terminally closes both bound Sessions", async () => {
  const clock = new FakeClock();
  const pair = new FakeWebSocketPair({ clock });
  const leftTransport = WebSocketTransport.fromSocket(pair.client, { clock });
  const rightTransport = WebSocketTransport.fromSocket(pair.server, { clock });
  const left = new Session(leftTransport, { clock });
  const right = new Session(rightTransport, { clock });
  const held = deferred();
  let handlerStarted = false;

  right.registerHandler("hold", async () => {
    handlerStarted = true;
    return held.promise;
  });
  const pending = observe(left.request("hold", null));
  await drain(clock);
  assert.equal(handlerStarted, true);

  const closing = leftTransport.close();
  await drain(clock);
  await closing;
  assertSDKError(
    await pending,
    sdkErrorCodes.sessionClosed,
    "delivered",
  );
  await assert.rejects(
    left.request("late", null),
    (error) =>
      error instanceof SDKError &&
      error.code === sdkErrorCodes.sessionClosed &&
      error.delivery === "not_sent",
  );
  await assert.rejects(
    right.request("late", null),
    (error) =>
      error instanceof SDKError &&
      error.code === sdkErrorCodes.sessionClosed &&
      error.delivery === "not_sent",
  );

  held.resolve("ignored");
  await drain(clock);
  await closeAll(clock, left, right);
  assert.equal(clock.pendingTimerCount, 0);
});
