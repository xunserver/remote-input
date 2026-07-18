import assert from "node:assert/strict";
import test from "node:test";

import {
  ACK_TIMEOUT_MS,
  CLOSE_ACK_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  MAX_QUEUED_MESSAGES,
  MAX_SEND_ATTEMPTS,
} from "../dist/constants.js";
import { sdkErrorCodes } from "../dist/errors.js";
import {
  FakeClock,
  FakeWebSocketPair,
  socketFactoryFrom,
} from "../dist/testing.js";
import {
  TransportSendCancelledError,
  WebSocketTransport,
} from "../dist/websocket-transport.js";

const textEncoder = new TextEncoder();

function request(requestId, payload = { requestId }) {
  return {
    type: "request",
    requestId,
    method: "test",
    payload,
  };
}

function receiver(overrides = {}) {
  return {
    accept() {},
    disconnected() {},
    localClosed() {},
    peerClosed() {},
    ...overrides,
  };
}

function frame(raw) {
  return JSON.parse(raw);
}

function dataFrame(transferId, message) {
  return JSON.stringify({
    kind: "DATA",
    transferId,
    chunkIndex: 0,
    chunkCount: 1,
    payload: JSON.stringify(message),
  });
}

function encodedDataFrame(transferId, message) {
  return JSON.stringify({
    kind: "DATA",
    transferId,
    chunkIndex: 0,
    chunkCount: 1,
    payload: JSON.stringify(message),
  });
}

function requestWithFinalFrameBytes(requestId, transferId, targetBytes) {
  const empty = request(requestId, { text: "" });
  const baseBytes = textEncoder.encode(encodedDataFrame(transferId, empty)).byteLength;
  assert.ok(baseBytes <= targetBytes);
  const message = request(requestId, {
    text: "x".repeat(targetBytes - baseBytes),
  });
  assert.equal(
    textEncoder.encode(encodedDataFrame(transferId, message)).byteLength,
    targetBytes,
  );
  return message;
}

function observe(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
}

async function flush(clock) {
  clock.flushMicrotasks();
  await Promise.resolve();
  clock.flushMicrotasks();
  await Promise.resolve();
}

function connectedPair(options = {}) {
  const clock = options.clock ?? new FakeClock();
  const pair = new FakeWebSocketPair({
    clock,
    synchronousDelivery: options.synchronousDelivery === true,
  });
  const left = WebSocketTransport.fromSocket(pair.client, { clock });
  const right = WebSocketTransport.fromSocket(pair.server, { clock });
  return { clock, pair, left, right };
}

test("TR-01/TR-05 URL factory connect and accepted-socket attach expose state", async () => {
  const clock = new FakeClock();
  const pair = new FakeWebSocketPair({ clock, autoOpen: false });
  const states = [];
  const transport = new WebSocketTransport("ws://example.test/ws", {
    clock,
    socketFactory: pair.socketFactory("client"),
  });
  transport.subscribe((state) => states.push(state));

  const connecting = transport.connect();
  assert.equal(transport.state, "connecting");
  pair.open();
  await flush(clock);
  await connecting;
  assert.equal(transport.state, "connected");
  assert.deepEqual(states, ["idle", "connecting", "connected"]);

  const accepted = WebSocketTransport.fromSocket(pair.server, { clock });
  assert.equal(accepted.state, "connected");
});

test("TR-01/TR-02/TR-06 snapshots immediately and ACKs only after accept", async () => {
  const { clock, pair, left, right } = connectedPair();
  const accepted = [];
  let acceptReturned = false;
  const deliveries = [];
  right.bind(receiver({
    accept(message) {
      accepted.push(message);
      acceptReturned = true;
    },
  }));
  left.bind(receiver());
  pair.setInterceptor((packet) => {
    if (packet.kind === "ACK" && packet.direction === "server-to-client") {
      assert.equal(acceptReturned, true, "ACK must be emitted after accept returns");
    }
  });

  const payload = { text: "原始🙂", nested: { value: 1 } };
  const sending = left.send(request(1, payload), {
    onDeliveryChange: (delivery) => deliveries.push(delivery),
  });
  payload.text = "mutated";
  payload.nested.value = 2;
  await flush(clock);
  await sending;

  assert.deepEqual(accepted, [request(1, { text: "原始🙂", nested: { value: 1 } })]);
  const outer = frame(pair.client.sent[0]);
  assert.equal(outer.kind, "DATA");
  assert.equal(outer.chunkIndex, 0);
  assert.equal(outer.chunkCount, 1);
  assert.equal(typeof outer.payload, "string");
  assert.deepEqual(JSON.parse(outer.payload), accepted[0]);
  assert.deepEqual(deliveries, ["unknown", "delivered"]);
});

test("TR-07 synchronous DATA/ACK still reports unknown before delivered", async () => {
  const { clock, left, right } = connectedPair({ synchronousDelivery: true });
  const order = [];
  left.bind(receiver());
  right.bind(receiver({
    accept() {
      order.push("accept");
    },
  }));

  const sending = left.send(request(1), {
    onDeliveryChange(delivery) {
      order.push(delivery);
    },
  });
  await flush(clock);
  await sending;
  assert.deepEqual(order, ["accept", "unknown", "delivered"]);
});

test("TR-03 final UTF-8 frame exactly at MAX_MESSAGE_BYTES is admitted", async () => {
  const { clock, pair, left, right } = connectedPair();
  left.bind(receiver());
  right.bind(receiver());
  const exact = requestWithFinalFrameBytes(1, 1, MAX_MESSAGE_BYTES);

  const sending = left.send(exact);
  await flush(clock);
  await sending;
  const raw = pair.client.sent.find((candidate) => frame(candidate).kind === "DATA");
  assert.equal(textEncoder.encode(raw).byteLength, MAX_MESSAGE_BYTES);

  const unicode = encodedDataFrame(2, request(2, { text: "中文🙂\"\\" }));
  assert.ok(textEncoder.encode(unicode).byteLength > unicode.length);
});

test("TR-04 MAX_QUEUED_BYTES includes active and queued final snapshots", async () => {
  const { clock, pair, left, right } = connectedPair();
  left.bind(receiver());
  right.bind(receiver());
  const queued = [];
  for (let id = 1; id <= 16; id += 1) {
    queued.push(
      observe(left.send(requestWithFinalFrameBytes(id, id, MAX_MESSAGE_BYTES))),
    );
  }
  const overflow = await observe(left.send(request(17)));
  assert.equal(overflow.status, "rejected");
  assert.equal(overflow.error.code, sdkErrorCodes.transportQueueFull);
  assert.equal(overflow.error.delivery, "not_sent");

  const closing = left.close();
  assert.equal(frame(pair.client.sent[0]).kind, "CLOSE");
  await flush(clock);
  await closing;
  await Promise.all(queued);
});

test("TR-12 strict FIFO waits for A terminal state before B and C", async () => {
  const { clock, pair, left, right } = connectedPair();
  const accepted = [];
  left.bind(receiver());
  right.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));
  pair.delayNext(100, { kind: "ACK", direction: "server-to-client" });

  const sends = [left.send(request(1)), left.send(request(2)), left.send(request(3))];
  await flush(clock);
  assert.deepEqual(accepted, [1]);
  assert.equal(pair.client.sent.filter((raw) => frame(raw).kind === "DATA").length, 1);

  clock.advanceBy(100);
  await flush(clock);
  await Promise.all(sends);
  assert.deepEqual(accepted, [1, 2, 3]);
});

test("TR-08/TR-09 lost ACK retries identical bytes and receiver accepts once", async () => {
  const { clock, pair, left, right } = connectedPair();
  let accepts = 0;
  left.bind(receiver());
  right.bind(receiver({ accept: () => { accepts += 1; } }));
  pair.dropNext({ kind: "ACK", direction: "server-to-client" });

  const sending = left.send(request(1));
  await flush(clock);
  assert.equal(accepts, 1);
  clock.advanceBy(ACK_TIMEOUT_MS);
  await flush(clock);
  await sending;

  const data = pair.client.sent.filter((raw) => frame(raw).kind === "DATA");
  assert.equal(data.length, 2);
  assert.equal(data[0], data[1]);
  assert.equal(accepts, 1);
});

test("TR-11/TR-13 A retry exhaustion rejects A but B and C continue", async () => {
  const { clock, pair, left, right } = connectedPair();
  const accepted = [];
  left.bind(receiver());
  right.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));
  pair.setInterceptor((packet) => {
    if (packet.kind !== "ACK" || packet.direction !== "server-to-client") {
      return undefined;
    }
    return frame(packet.data).transferId === 1 ? { drop: true } : undefined;
  });

  const a = observe(left.send(request(1)));
  const b = left.send(request(2));
  const c = left.send(request(3));
  await flush(clock);
  clock.advanceBy(ACK_TIMEOUT_MS * MAX_SEND_ATTEMPTS);
  await flush(clock);

  const aResult = await a;
  assert.equal(aResult.status, "rejected");
  assert.equal(aResult.error.code, sdkErrorCodes.deliveryUnconfirmed);
  assert.equal(aResult.error.delivery, "unknown");
  await Promise.all([b, c]);
  assert.deepEqual(accepted, [1, 2, 3]);
  assert.equal(
    pair.client.sent.filter(
      (raw) => frame(raw).kind === "DATA" && frame(raw).transferId === 1,
    ).length,
    MAX_SEND_ATTEMPTS,
  );
});

test("TR-10 stale and wrong ACKs do not advance the FIFO", async () => {
  const { clock, pair, left, right } = connectedPair();
  const accepted = [];
  left.bind(receiver());
  right.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));
  pair.dropNext({ kind: "ACK", direction: "server-to-client" });

  const a = left.send(request(1));
  const b = left.send(request(2));
  await flush(clock);
  pair.server.send(JSON.stringify({ kind: "ACK", transferId: 999, chunkIndex: 0 }));
  await flush(clock);
  assert.deepEqual(accepted, [1]);

  clock.advanceBy(ACK_TIMEOUT_MS);
  await flush(clock);
  await Promise.all([a, b]);
  assert.deepEqual(accepted, [1, 2]);
});

test("TR-30 DATA without a receiver is unacked and a later retry can deliver", async () => {
  const { clock, left, right } = connectedPair();
  right.bind(receiver());
  const sending = right.send(request(1));
  await flush(clock);

  const accepted = [];
  left.bind(receiver({ accept: (message) => accepted.push(message) }));
  clock.advanceBy(ACK_TIMEOUT_MS);
  await flush(clock);
  await sending;
  assert.deepEqual(accepted, [request(1)]);
});

test("TR-23 high-water duplicate is re-ACKed; lower/conflicting IDs are dropped", async () => {
  const { clock, pair, left } = connectedPair();
  const accepted = [];
  left.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));

  const high = dataFrame(5, request(5));
  pair.server.send(high);
  pair.server.send(high);
  await flush(clock);
  assert.deepEqual(accepted, [5]);
  assert.equal(pair.client.sent.filter((raw) => frame(raw).kind === "ACK").length, 2);

  pair.server.send(dataFrame(5, request(55)));
  pair.server.send(dataFrame(4, request(4)));
  await flush(clock);
  assert.deepEqual(accepted, [5]);
  assert.equal(pair.client.sent.filter((raw) => frame(raw).kind === "ACK").length, 2);
});

test("TR-24 malformed, non-text, extra-field, and invalid payload frames are not ACKed", async () => {
  const { clock, pair, left } = connectedPair();
  let accepts = 0;
  left.bind(receiver({ accept: () => { accepts += 1; } }));

  pair.server.send("{");
  pair.server.send(JSON.stringify({
    kind: "DATA",
    transferId: 1,
    chunkIndex: 0,
    chunkCount: 1,
    payload: "{",
  }));
  pair.server.send(JSON.stringify({
    kind: "DATA",
    transferId: 2,
    chunkIndex: 0,
    chunkCount: 1,
    payload: JSON.stringify(request(2)),
    extra: true,
  }));
  pair.server.send("x".repeat(MAX_MESSAGE_BYTES + 1));
  pair.client.emit("message", { data: new Uint8Array([1, 2, 3]) });
  await flush(clock);

  assert.equal(accepts, 0);
  assert.equal(pair.client.sent.filter((raw) => frame(raw).kind === "ACK").length, 0);
});

test("TR-03/TR-04 enforce final-frame bytes and queue admission; CLOSE bypasses queue", async () => {
  const { clock, pair, left, right } = connectedPair();
  left.bind(receiver());
  right.bind(receiver());

  const tooLarge = await observe(
    left.send(request(1, { text: "x".repeat(MAX_MESSAGE_BYTES) })),
  );
  assert.equal(tooLarge.status, "rejected");
  assert.equal(tooLarge.error.code, sdkErrorCodes.messageTooLarge);
  assert.equal(tooLarge.error.delivery, "not_sent");

  const queued = [];
  for (let id = 1; id <= MAX_QUEUED_MESSAGES; id += 1) {
    queued.push(observe(left.send(request(id))));
  }
  const overflow = await observe(left.send(request(MAX_QUEUED_MESSAGES + 1)));
  assert.equal(overflow.status, "rejected");
  assert.equal(overflow.error.code, sdkErrorCodes.transportQueueFull);
  assert.equal(overflow.error.delivery, "not_sent");

  const closing = left.close();
  assert.deepEqual(pair.client.sent.map((raw) => frame(raw).kind), ["CLOSE"]);
  await flush(clock);
  await closing;
  const results = await Promise.all(queued);
  assert.ok(results.every((result) => result.status === "rejected"));
});

test("TR-15 queued AbortSignal removes B while A remains active", async () => {
  const { clock, pair, left, right } = connectedPair();
  const accepted = [];
  left.bind(receiver());
  right.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));
  pair.dropNext({ kind: "ACK", direction: "server-to-client" });

  const a = left.send(request(1));
  const controller = new AbortController();
  const b = observe(left.send(request(2), { signal: controller.signal }));
  controller.abort();
  await flush(clock);
  const bResult = await b;
  assert.equal(bResult.status, "rejected");
  assert.ok(bResult.error instanceof TransportSendCancelledError);
  assert.equal(bResult.error.delivery, "not_sent");
  assert.deepEqual(accepted, [1]);

  clock.advanceBy(ACK_TIMEOUT_MS);
  await flush(clock);
  await a;
  assert.deepEqual(accepted, [1]);
});

test("TR-16 active AbortSignal stops retries and B continues", async () => {
  const { clock, pair, left, right } = connectedPair();
  const accepted = [];
  left.bind(receiver());
  right.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));
  pair.setInterceptor((packet) =>
    packet.kind === "ACK" &&
    packet.direction === "server-to-client" &&
    frame(packet.data).transferId === 1
      ? { drop: true }
      : undefined,
  );
  const controller = new AbortController();
  const a = observe(left.send(request(1), { signal: controller.signal }));
  const b = left.send(request(2));
  await flush(clock);
  controller.abort();
  await flush(clock);

  const result = await a;
  assert.equal(result.status, "rejected");
  assert.ok(result.error instanceof TransportSendCancelledError);
  assert.equal(result.error.delivery, "unknown");
  await b;
  assert.deepEqual(accepted, [1, 2]);
});

test("TR-16/TR-27 active deadline stops retry and releases the next FIFO item", async () => {
  const { clock, pair, left, right } = connectedPair();
  const accepted = [];
  left.bind(receiver());
  right.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));
  pair.setInterceptor((packet) => {
    if (
      packet.kind === "ACK" &&
      packet.direction === "server-to-client" &&
      frame(packet.data).transferId === 1
    ) {
      return { drop: true };
    }
    return undefined;
  });

  const a = observe(left.send(request(1), { deadlineAt: 1_000 }));
  const b = left.send(request(2));
  await flush(clock);
  clock.advanceBy(1_000);
  await flush(clock);

  const aResult = await a;
  assert.equal(aResult.status, "rejected");
  assert.equal(aResult.error.code, sdkErrorCodes.requestTimeout);
  assert.equal(aResult.error.delivery, "unknown");
  await b;
  assert.deepEqual(accepted, [1, 2]);
});

test("TR-17 disconnect rejects active unknown then queued not_sent and keeps receiver", async () => {
  const { clock, pair, left, right } = connectedPair();
  let disconnects = 0;
  left.bind(receiver({ disconnected: () => { disconnects += 1; } }));
  right.bind(receiver());
  pair.setInterceptor((packet) =>
    packet.kind === "ACK" && packet.direction === "server-to-client"
      ? { drop: true }
      : undefined,
  );

  const a = observe(left.send(request(1)));
  const b = observe(left.send(request(2)));
  await flush(clock);
  pair.disconnect();
  await flush(clock);

  const [aResult, bResult] = await Promise.all([a, b]);
  assert.equal(aResult.error.code, sdkErrorCodes.transportDisconnected);
  assert.equal(aResult.error.delivery, "unknown");
  assert.equal(bResult.error.code, sdkErrorCodes.transportDisconnected);
  assert.equal(bResult.error.delivery, "not_sent");
  assert.equal(disconnects, 1);
  assert.equal(left.state, "idle");
});

test("TR-18/TR-19 reconnect resets transfer IDs and captured old callbacks are inert", async () => {
  const clock = new FakeClock();
  const first = new FakeWebSocketPair({ clock });
  const second = new FakeWebSocketPair({ clock });
  const left = new WebSocketTransport("ws://test", {
    clock,
    socketFactory: socketFactoryFrom(first.client, second.client),
  });
  const accepted = [];
  left.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));
  const right1 = WebSocketTransport.fromSocket(first.server, { clock });
  right1.bind(receiver());
  await left.connect();
  const oldListeners = {
    open: first.client.captureListeners("open"),
    message: first.client.captureListeners("message"),
    close: first.client.captureListeners("close"),
    error: first.client.captureListeners("error"),
  };

  first.disconnect();
  await flush(clock);
  assert.equal(left.state, "idle");
  assert.equal(first.client.listenerCount(), 0);

  const right2 = WebSocketTransport.fromSocket(second.server, { clock });
  right2.bind(receiver());
  await left.connect();
  second.dropNext({ kind: "ACK", direction: "server-to-client" });
  const sending = left.send(request(2));
  await flush(clock);
  first.client.emitCaptured(oldListeners.message, "message", {
    data: JSON.stringify({ kind: "ACK", transferId: 1, chunkIndex: 0 }),
  });
  first.client.emitCaptured(oldListeners.message, "message", {
    data: dataFrame(99, request(99)),
  });
  first.client.emitCaptured(oldListeners.close, "close", { code: 1006 });
  first.client.emitCaptured(oldListeners.error, "error", {});
  first.client.emitCaptured(oldListeners.open, "open", {});
  assert.equal(left.state, "connected");
  clock.advanceBy(ACK_TIMEOUT_MS);
  await flush(clock);
  await sending;

  const newData = second.client.sent.find((raw) => frame(raw).kind === "DATA");
  assert.equal(frame(newData).transferId, 1);
  assert.deepEqual(accepted, []);
  assert.equal(left.state, "connected");
});

test("disconnect receiver can synchronously reconnect and send without old reset clobbering it", async () => {
  const clock = new FakeClock();
  const first = new FakeWebSocketPair({ clock });
  const second = new FakeWebSocketPair({ clock });
  const left = new WebSocketTransport("ws://test", {
    clock,
    socketFactory: socketFactoryFrom(first.client, second.client),
  });
  const right1 = WebSocketTransport.fromSocket(first.server, { clock });
  const accepted = [];
  const right2 = WebSocketTransport.fromSocket(second.server, { clock });
  right1.bind(receiver());
  right2.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));
  let reconnect;
  let sending;
  left.bind(receiver({
    disconnected() {
      reconnect = left.connect();
      sending = left.send(request(2));
    },
  }));
  await left.connect();

  first.disconnect();
  await flush(clock);
  await reconnect;
  await sending;
  assert.equal(left.state, "connected");
  assert.deepEqual(accepted, [2]);
});

test("idle state listener can synchronously reconnect and send", async () => {
  const clock = new FakeClock();
  const first = new FakeWebSocketPair({ clock });
  const second = new FakeWebSocketPair({ clock });
  const left = new WebSocketTransport("ws://test", {
    clock,
    socketFactory: socketFactoryFrom(first.client, second.client),
  });
  const right1 = WebSocketTransport.fromSocket(first.server, { clock });
  const accepted = [];
  const right2 = WebSocketTransport.fromSocket(second.server, { clock });
  left.bind(receiver());
  right1.bind(receiver());
  right2.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));
  await left.connect();
  let reconnect;
  let sending;
  left.subscribe((state) => {
    if (state === "idle" && left.state === "idle" && reconnect === undefined) {
      reconnect = left.connect();
      sending = left.send(request(3));
    }
  });

  first.disconnect();
  await flush(clock);
  await reconnect;
  await sending;
  assert.equal(left.state, "connected");
  assert.deepEqual(accepted, [3]);
});

test("TR-20 synchronous CLOSE/CLOSE_ACK leaves both peers closed and cleans listeners", async () => {
  const { clock, pair, left, right } = connectedPair({ synchronousDelivery: true });
  let localClosed = 0;
  let peerClosed = 0;
  let disconnected = 0;
  left.bind(receiver({ localClosed: () => { localClosed += 1; } }));
  right.bind(receiver({
    peerClosed: () => { peerClosed += 1; },
    disconnected: () => { disconnected += 1; },
  }));

  await left.close();
  assert.equal(left.state, "closed");
  assert.equal(right.state, "closed");
  assert.equal(localClosed, 1);
  assert.equal(peerClosed, 1);
  assert.equal(disconnected, 0);
  assert.equal(clock.pendingTimerCount, 0);
  assert.equal(pair.client.listenerCount(), 0);
  assert.equal(pair.server.listenerCount(), 0);
});

test("TR-21 missing CLOSE reaches fixed timeout and repeated close is idempotent", async () => {
  const { clock, pair, left, right } = connectedPair();
  let localClosed = 0;
  left.bind(receiver({ localClosed: () => { localClosed += 1; } }));
  right.bind(receiver());
  pair.dropNext({ kind: "CLOSE", direction: "client-to-server" });

  const firstClose = left.close();
  const secondClose = left.close();
  assert.equal(left.state, "closing");
  clock.advanceBy(CLOSE_ACK_TIMEOUT_MS);
  await flush(clock);
  await Promise.all([firstClose, secondClose]);
  assert.equal(left.state, "closed");
  assert.equal(localClosed, 1);
  await left.close();
  assert.equal(localClosed, 1);
  assert.equal(clock.pendingTimerCount, 0);
});

test("TR-21 dropped CLOSE_ACK reaches timeout even while peer socket stays open", async () => {
  const clock = new FakeClock();
  const pair = new FakeWebSocketPair({ clock });
  const left = WebSocketTransport.fromSocket(pair.client, { clock });
  left.bind(receiver());
  pair.server.addEventListener("message", (event) => {
    if (frame(event.data).kind === "CLOSE") {
      pair.server.send(JSON.stringify({ kind: "CLOSE_ACK" }));
    }
  });
  pair.dropNext({ kind: "CLOSE_ACK", direction: "server-to-client" });

  const closing = left.close();
  await flush(clock);
  assert.equal(left.state, "closing");
  assert.equal(pair.server.readyState, 1);
  clock.advanceBy(CLOSE_ACK_TIMEOUT_MS);
  await flush(clock);
  await closing;
  assert.equal(left.state, "closed");
  assert.equal(clock.pendingTimerCount, 0);
});

test("TR-22 simultaneous close has no deadlock or duplicate terminal callbacks", async () => {
  const { clock, left, right } = connectedPair();
  let leftLocal = 0;
  let rightLocal = 0;
  let peers = 0;
  left.bind(receiver({
    localClosed: () => { leftLocal += 1; },
    peerClosed: () => { peers += 1; },
  }));
  right.bind(receiver({
    localClosed: () => { rightLocal += 1; },
    peerClosed: () => { peers += 1; },
  }));

  const leftClose = left.close();
  const rightClose = right.close();
  await flush(clock);
  await Promise.all([leftClose, rightClose]);
  assert.equal(left.state, "closed");
  assert.equal(right.state, "closed");
  assert.equal(leftLocal, 1);
  assert.equal(rightLocal, 1);
  assert.equal(peers, 0);
  assert.equal(clock.pendingTimerCount, 0);
});

test("TR-31 closed listener may attach a connecting socket without old close clobbering it", async () => {
  const clock = new FakeClock();
  const first = new FakeWebSocketPair({ clock });
  const second = new FakeWebSocketPair({ clock, autoOpen: false });
  const left = WebSocketTransport.fromSocket(first.client, { clock });
  const right1 = WebSocketTransport.fromSocket(first.server, { clock });
  const accepted = [];
  const right2 = WebSocketTransport.fromSocket(second.server, { clock });
  left.bind(receiver());
  right1.bind(receiver());
  right2.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));

  let reconnect;
  let reused = false;
  left.subscribe((state) => {
    if (state === "closed" && !reused) {
      reused = true;
      left.bind(receiver());
      reconnect = left.attach(second.client);
    }
  });

  const closing = left.close();
  await flush(clock);
  await closing;
  assert.equal(left.state, "connecting");
  second.open();
  await flush(clock);
  await reconnect;
  const sending = left.send(request(2));
  await flush(clock);
  await sending;
  assert.equal(left.state, "connected");
  assert.deepEqual(accepted, [2]);
});

test("encoding reentrancy cannot enqueue an item after Proxy closes the connection", async () => {
  const { clock, pair, left, right } = connectedPair();
  left.bind(receiver());
  right.bind(receiver());
  let closed = false;
  const proxied = new Proxy(request(1), {
    getPrototypeOf(target) {
      if (!closed) {
        closed = true;
        void left.close();
      }
      return Reflect.getPrototypeOf(target);
    },
  });

  const result = observe(left.send(proxied));
  await flush(clock);
  const settled = await result;
  assert.equal(settled.status, "rejected");
  assert.equal(settled.error.code, sdkErrorCodes.transportNotConnected);
  assert.equal(settled.error.delivery, "not_sent");
  assert.equal(
    pair.client.sent.filter((raw) => frame(raw).kind === "DATA").length,
    0,
  );
});

test("TR-25 every non-JSON snapshot fails ENCODE_ERROR before DATA is queued", async () => {
  const { pair, left, right } = connectedPair();
  left.bind(receiver());
  right.bind(receiver());
  const cyclic = {};
  cyclic.self = cyclic;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      return 1;
    },
  });
  const hiddenToJson = { value: 1 };
  Object.defineProperty(hiddenToJson, "toJSON", {
    enumerable: false,
    value() {
      return { value: 2 };
    },
  });
  const withSymbol = { value: 1 };
  withSymbol[Symbol("hidden")] = 2;
  const sparse = [];
  sparse.length = 1;

  const invalidPayloads = [
    undefined,
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    cyclic,
    accessor,
    hiddenToJson,
    withSymbol,
    sparse,
    new Date(),
  ];
  const results = await Promise.all(
    invalidPayloads.map((payload, index) =>
      observe(left.send({
        ...request(index + 1, null),
        payload,
      })),
    ),
  );
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.ok(
    results.every(
      (result) =>
        result.error.code === sdkErrorCodes.encodeError &&
        result.error.delivery === "not_sent",
    ),
  );
  assert.equal(pair.client.sent.length, 0);
});

test("TR-26 descriptor walk crossing deadline does not enqueue or send", async () => {
  const { clock, pair, left, right } = connectedPair();
  left.bind(receiver());
  right.bind(receiver());
  let advanced = false;
  const proxied = new Proxy(request(1), {
    getOwnPropertyDescriptor(target, key) {
      if (!advanced) {
        advanced = true;
        clock.advanceBy(10);
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  const result = await observe(left.send(proxied, { deadlineAt: 5 }));
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, sdkErrorCodes.requestTimeout);
  assert.equal(result.error.delivery, "not_sent");
  assert.equal(pair.client.sent.length, 0);
});

test("TR-28 transferId accepts MAX_SAFE_INTEGER once and never wraps", async () => {
  const { clock, pair, left, right } = connectedPair();
  left.bind(receiver());
  right.bind(receiver());
  left.nextTransferId = Number.MAX_SAFE_INTEGER;

  const finalId = left.send(request(1));
  await flush(clock);
  await finalId;
  const raw = pair.client.sent.find((candidate) => frame(candidate).kind === "DATA");
  assert.equal(frame(raw).transferId, Number.MAX_SAFE_INTEGER);

  const exhausted = await observe(left.send(request(2)));
  assert.equal(exhausted.status, "rejected");
  assert.equal(exhausted.error.code, sdkErrorCodes.transportNotConnected);
  assert.equal(exhausted.error.delivery, "not_sent");
});

test("TR-29 bind is one-to-one, idempotent, and stale unbind cannot remove replacement", async () => {
  const { clock, pair, left } = connectedPair();
  const first = receiver();
  const accepted = [];
  const replacement = receiver({ accept: (message) => accepted.push(message.requestId) });
  const stranger = receiver();

  left.bind(first);
  left.bind(first);
  assert.throws(() => left.bind(replacement), /already has a bound receiver/);
  left.unbind(stranger);
  assert.throws(() => left.bind(replacement), /already has a bound receiver/);
  left.unbind(first);
  left.bind(replacement);
  left.unbind(first);
  pair.server.send(dataFrame(1, request(1)));
  await flush(clock);
  assert.deepEqual(accepted, [1]);
});

test("attach listener installation failure detaches partial listeners and settles", async () => {
  const clock = new FakeClock();
  const pair = new FakeWebSocketPair({ clock });
  const socket = pair.client;
  const originalAdd = socket.addEventListener.bind(socket);
  socket.addEventListener = (type, listener) => {
    if (type === "message") {
      throw new Error("injected listener failure");
    }
    originalAdd(type, listener);
  };
  const transport = new WebSocketTransport("ws://test", { clock });

  const result = await observe(transport.attach(socket));
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, sdkErrorCodes.transportNotConnected);
  assert.equal(result.error.delivery, "not_sent");
  assert.equal(transport.state, "idle");
  assert.equal(socket.listenerCount(), 0);
});

test("long deadlines are armed in safe timer-sized segments", async () => {
  const clock = new FakeClock();
  const recordedDelays = [];
  const wrappedClock = {
    now: () => clock.now(),
    setTimeout(callback, delay) {
      recordedDelays.push(delay);
      return clock.setTimeout(callback, delay);
    },
    clearTimeout: (handle) => clock.clearTimeout(handle),
    queueMicrotask: (callback) => clock.queueMicrotask(callback),
  };
  const pair = new FakeWebSocketPair({ clock: wrappedClock });
  const left = WebSocketTransport.fromSocket(pair.client, { clock: wrappedClock });
  const right = WebSocketTransport.fromSocket(pair.server, { clock: wrappedClock });
  left.bind(receiver());
  right.bind(receiver());
  const controller = new AbortController();
  const sending = observe(left.send(request(1), {
    signal: controller.signal,
    deadlineAt: 2_147_483_647 + 50,
  }));
  assert.equal(recordedDelays[0], 2_147_483_647);
  controller.abort();
  const result = await sending;
  assert.equal(result.status, "rejected");
});
