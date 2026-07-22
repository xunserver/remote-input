import assert from "node:assert/strict";
import test from "node:test";

import {
  ACK_TIMEOUT_MS,
  CHUNK_PAYLOAD_BYTES,
  CLOSE_ACK_TIMEOUT_MS,
  MAX_CHUNKS_PER_TRANSFER,
  MAX_IN_FLIGHT_CHUNKS,
  MAX_MESSAGE_BYTES,
  MAX_QUEUED_BYTES,
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

function chunkPayload(payload, maxBytes = CHUNK_PAYLOAD_BYTES) {
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of Array.from(payload)) {
    const codePointBytes = textEncoder.encode(codePoint).byteLength;
    if (current && currentBytes + codePointBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += codePointBytes;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function asciiTextSpanningChunks(chunkCount) {
  return "x".repeat(CHUNK_PAYLOAD_BYTES * (chunkCount - 1));
}

function maxSizedUnicodeMessage(requestId = 1) {
  const emptyMessage = request(requestId, { text: "" });
  const contentBytes =
    MAX_MESSAGE_BYTES - textEncoder.encode(JSON.stringify(emptyMessage)).byteLength;
  const emojiCount = Math.floor(contentBytes / 4);
  const trailingAsciiBytes = contentBytes - emojiCount * 4;
  return request(requestId, {
    text: `${"🙂".repeat(emojiCount)}${"x".repeat(trailingAsciiBytes)}`,
  });
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
  const left = WebSocketTransport.fromSocket(pair.client, {
    ...options.leftOptions,
    clock,
    ...(options.chunkWindowSize === undefined
      ? {}
      : { chunkWindowSize: options.chunkWindowSize }),
  });
  const right = WebSocketTransport.fromSocket(pair.server, {
    ...options.rightOptions,
    clock,
    ...(options.chunkWindowSize === undefined
      ? {}
      : { chunkWindowSize: options.chunkWindowSize }),
  });
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

test("chunk window configuration requires a positive safe integer", () => {
  for (const chunkWindowSize of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_CHUNKS_PER_TRANSFER + 1,
  ]) {
    assert.throws(
      () => new WebSocketTransport("ws://example.test/ws", { chunkWindowSize }),
      RangeError,
    );
  }
  assert.doesNotThrow(
    () => new WebSocketTransport("ws://example.test/ws", { chunkWindowSize: 1 }),
  );
  assert.throws(
    () => new WebSocketTransport("ws://example.test/ws", { traceLevel: "verbose" }),
    /traceLevel must be/,
  );
});

test("default chunk payload is 64 KiB with a conservative five-chunk bound", () => {
  assert.equal(CHUNK_PAYLOAD_BYTES, 64 * 1024);
  assert.equal(MAX_CHUNKS_PER_TRANSFER, 5);
});

test("TR-01/TR-02/TR-06 snapshots immediately and completes ACKs after accept", async () => {
  const { clock, pair, left, right } = connectedPair();
  const accepted = [];
  let acceptReturned = false;
  const deliveries = [];
  const ackObservations = [];
  right.bind(receiver({
    accept(message) {
      accepted.push(message);
      acceptReturned = true;
    },
  }));
  left.bind(receiver());
  pair.setInterceptor((packet) => {
    if (packet.kind === "ACK" && packet.direction === "server-to-client") {
      ackObservations.push({
        ...frame(packet.data),
        acceptReturned,
      });
    }
  });

  const padding = "x".repeat(CHUNK_PAYLOAD_BYTES);
  const payload = { text: "原始🙂", nested: { value: 1 }, padding };
  const sending = left.send(request(1, payload), {
    onDeliveryChange: (delivery) => deliveries.push(delivery),
  });
  payload.text = "mutated";
  payload.nested.value = 2;
  await flush(clock);
  await sending;

  assert.deepEqual(accepted, [
    request(1, { text: "原始🙂", nested: { value: 1 }, padding }),
  ]);
  const data = pair.client.sent
    .map(frame)
    .filter((candidate) => candidate.kind === "DATA");
  assert.ok(data.length >= 2);
  assert.equal(new Set(data.map((candidate) => candidate.transferId)).size, 1);
  assert.equal(new Set(data.map((candidate) => candidate.chunkCount)).size, 1);
  assert.deepEqual(
    JSON.parse(data.sort((a, b) => a.chunkIndex - b.chunkIndex).map((candidate) => candidate.payload).join("")),
    accepted[0],
  );
  assert.ok(
    data.every(
      (candidate) => textEncoder.encode(candidate.payload).byteLength <= CHUNK_PAYLOAD_BYTES,
    ),
  );
  assert.ok(ackObservations.some((ack) => ack.acceptReturned === false));
  assert.equal(
    ackObservations.find((ack) => ack.chunkIndex === data.length - 1)?.acceptReturned,
    true,
  );
  assert.deepEqual(deliveries, ["unknown", "delivered"]);
});

test("TR-02 5000 CJK characters fit in one 64 KiB chunk", async () => {
  const { clock, pair, left, right } = connectedPair({ chunkWindowSize: MAX_IN_FLIGHT_CHUNKS });
  const accepted = [];
  right.bind(receiver({ accept: (message) => accepted.push(message) }));
  left.bind(receiver());

  const message = {
    ...request(1, { text: "汉".repeat(5000) }),
    method: "sendText",
  };
  assert.equal(textEncoder.encode(JSON.stringify(message)).byteLength, 15074);
  const sending = left.send(message);
  await flush(clock);
  await sending;

  const data = pair.client.sent
    .map(frame)
    .filter((candidate) => candidate.kind === "DATA");
  assert.equal(data.length, 1);
  assert.equal(new Set(data.map((candidate) => candidate.transferId)).size, 1);
  assert.deepEqual(
    [...new Set(data.map((candidate) => candidate.chunkCount))],
    [1],
  );
  assert.deepEqual(
    data.map((candidate) => candidate.chunkIndex).sort((a, b) => a - b),
    [0],
  );
  assert.ok(
    data.every(
      (candidate) => textEncoder.encode(candidate.payload).byteLength <= CHUNK_PAYLOAD_BYTES,
    ),
  );
  assert.deepEqual(accepted, [message]);
});

test("chunk trace exposes every multi-chunk window event without payload content", async () => {
  const events = [];
  const receiverEvents = [];
  const { clock, left, right } = connectedPair({
    leftOptions: {
      traceLevel: "chunks",
      onTrace: (event) => events.push(event),
    },
    rightOptions: {
      traceLevel: "chunks",
      onTrace: (event) => receiverEvents.push(event),
    },
  });
  left.bind(receiver());
  right.bind(receiver());
  const privateMarker = "private-chunk-content-marker";
  const message = {
    ...request(1, {
      text: `${privateMarker}${asciiTextSpanningChunks(3)}`,
    }),
    method: "sendText",
  };

  const sending = left.send(message);
  await flush(clock);
  await sending;
  await Promise.resolve();

  const sent = events.filter((event) => event.event === "chunk.send");
  const acknowledged = events.filter(
    (event) => event.event === "chunk.ack.received",
  );
  const expectedChunks = sent[0]?.details.chunkCount;
  assert.equal(expectedChunks, 3);
  assert.equal(sent.length, expectedChunks);
  assert.equal(acknowledged.length, expectedChunks);
  const sentAcks = receiverEvents.filter((event) => event.event === "ack.send");
  assert.equal(sentAcks.length, expectedChunks);
  assert.ok(
    sentAcks.every((event) => event.details.chunkCount === expectedChunks),
  );
  assert.equal(sent[0].details.chunkIndex, 0);
  assert.equal(sent.at(-1).details.chunkIndex, expectedChunks - 1);
  assert.ok(events.every((event) => Object.isFrozen(event)));
  assert.ok(events.every((event) => Object.isFrozen(event.details)));
  assert.equal(JSON.stringify(events).includes(privateMarker), false);
  assert.equal(JSON.stringify(receiverEvents).includes(privateMarker), false);

  const firstReceived = receiverEvents.findIndex(
    (event) => event.event === "chunk.received" && event.details.chunkIndex === 0,
  );
  const firstCached = receiverEvents.findIndex(
    (event) => event.event === "chunk.cached" && event.details.chunkIndex === 0,
  );
  const firstAck = receiverEvents.findIndex(
    (event) => event.event === "ack.send" && event.details.chunkIndex === 0,
  );
  assert.ok(firstReceived < firstCached && firstCached < firstAck);

  const lastReceived = receiverEvents.findIndex(
    (event) =>
      event.event === "chunk.received" &&
      event.details.chunkIndex === expectedChunks - 1,
  );
  const reassembled = receiverEvents.findIndex(
    (event) => event.event === "transfer.reassembled",
  );
  const accepted = receiverEvents.findIndex(
    (event) => event.event === "receiver.accept.done",
  );
  const lastAck = receiverEvents.findIndex(
    (event) =>
      event.event === "ack.send" &&
      event.details.chunkIndex === expectedChunks - 1,
  );
  assert.ok(lastReceived < reassembled && reassembled < accepted && accepted < lastAck);
});

test("summary trace omits chunk events and throwing observers cannot break send", async () => {
  const events = [];
  const { clock, left, right } = connectedPair({
    leftOptions: {
      traceLevel: "summary",
      onTrace: (event) => events.push(event),
    },
    rightOptions: {
      traceLevel: "chunks",
      onTrace() {
        throw new Error("trace failure");
      },
    },
  });
  left.bind(receiver());
  right.bind(receiver());

  const sending = left.send(request(1, { text: "private-flow-marker" }));
  await flush(clock);
  await sending;
  await Promise.resolve();

  assert.ok(events.some((event) => event.event === "transfer.queued"));
  assert.ok(events.some((event) => event.event === "transfer.completed"));
  assert.equal(
    events.some(
      (event) => event.event.startsWith("chunk.") || event.event === "ack.send",
    ),
    false,
  );
  assert.equal(JSON.stringify(events).includes("private-flow-marker"), false);
});

test("trace clock failures cannot make a transport send throw", async () => {
  const clock = new FakeClock();
  const pair = new FakeWebSocketPair({ clock });
  const throwingClock = {
    now() {
      throw new Error("trace clock failure");
    },
    setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
    clearTimeout: (handle) => clock.clearTimeout(handle),
    queueMicrotask: (callback) => clock.queueMicrotask(callback),
  };
  const left = WebSocketTransport.fromSocket(pair.client, {
    clock: throwingClock,
    traceLevel: "summary",
    onTrace() {},
  });
  const right = WebSocketTransport.fromSocket(pair.server, { clock });
  left.bind(receiver());
  right.bind(receiver());

  let sending;
  assert.doesNotThrow(() => {
    sending = left.send(request(1));
  });
  await flush(clock);
  assert.equal((await observe(sending)).status, "fulfilled");
});

test("near-limit mixed Unicode payload stays within the conservative chunk bound", async () => {
  const { clock, pair, left, right } = connectedPair();
  const accepted = [];
  right.bind(receiver({ accept: (message) => accepted.push(message) }));
  left.bind(receiver());

  // The ASCII JSON prefix does not align with four-byte emoji boundaries.
  // A maximum-sized payload therefore exercises the fifth,
  // conservative chunk slot without exceeding the 256 KiB message limit.
  const message = maxSizedUnicodeMessage();
  const payloadBytes = textEncoder.encode(JSON.stringify(message)).byteLength;
  assert.equal(payloadBytes, MAX_MESSAGE_BYTES);

  const sending = left.send(message);
  await flush(clock);
  await sending;
  const data = pair.client.sent
    .map(frame)
    .filter((candidate) => candidate.kind === "DATA");
  assert.equal(data.length, MAX_CHUNKS_PER_TRANSFER);
  assert.deepEqual(accepted, [message]);
});

test("chunking preserves emoji, supplementary CJK, escapes, and control characters", async () => {
  const { clock, pair, left, right } = connectedPair();
  const accepted = [];
  right.bind(receiver({ accept: (message) => accepted.push(message) }));
  left.bind(receiver());
  const message = request(1, {
    text: "汉🙂𠀀\"\\\n".repeat(10_000),
  });

  const sending = left.send(message);
  await flush(clock);
  await sending;

  const chunks = pair.client.sent
    .map(frame)
    .filter((candidate) => candidate.kind === "DATA");
  assert.ok(chunks.length > 1);
  assert.ok(
    chunks.every(
      (candidate) => textEncoder.encode(candidate.payload).byteLength <= CHUNK_PAYLOAD_BYTES,
    ),
  );
  assert.equal(chunks.some((candidate) => candidate.payload.includes("�")), false);
  assert.deepEqual(accepted, [message]);
});

test("out-of-order chunks reassemble once and completed duplicates are re-ACKed", async () => {
  const { clock, pair, left } = connectedPair();
  const accepted = [];
  left.bind(receiver({ accept: (message) => accepted.push(message) }));
  const message = request(1, { text: asciiTextSpanningChunks(3) });
  const payloadChunks = chunkPayload(JSON.stringify(message));
  assert.ok(payloadChunks.length >= 3);
  const frames = payloadChunks.map((payload, chunkIndex) => JSON.stringify({
    kind: "DATA",
    transferId: 7,
    chunkIndex,
    chunkCount: payloadChunks.length,
    payload,
  }));

  for (const raw of [...frames].reverse()) pair.server.send(raw);
  await flush(clock);
  assert.deepEqual(accepted, [message]);

  pair.server.send(frames[0]);
  await flush(clock);
  assert.deepEqual(accepted, [message]);
  const acknowledgements = pair.client.sent
    .map(frame)
    .filter((candidate) => candidate.kind === "ACK" && candidate.transferId === 7);
  assert.ok(acknowledgements.some((candidate) => candidate.chunkIndex === 0));
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
  // A synchronous adapter can deliver to the peer before socket.send()
  // returns. The public delivery observer still advances monotonically.
  assert.deepEqual(order, ["accept", "unknown", "delivered"]);
});

test("synchronous disconnect during socket.send reports an unknown delivery", async () => {
  const { clock, pair, left, right } = connectedPair({ synchronousDelivery: true });
  left.bind(receiver());
  right.bind(receiver());
  let disconnected = false;
  pair.setInterceptor((packet) => {
    if (packet.kind === "DATA" && packet.direction === "client-to-server" && !disconnected) {
      disconnected = true;
      pair.disconnect();
    }
    return undefined;
  });

  const sending = observe(left.send(request(1)));
  await flush(clock);
  const result = await sending;
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, sdkErrorCodes.transportDisconnected);
  assert.equal(result.error.delivery, "unknown");
});

test("reentrant higher DATA does not let an outer accept commit stale state", async () => {
  const { clock, pair, left } = connectedPair({ synchronousDelivery: true });
  const accepted = [];
  let nested = false;
  left.bind(receiver({
    accept(message) {
      accepted.push(message.requestId);
      if (message.requestId === 1 && !nested) {
        nested = true;
        pair.server.send(dataFrame(2, request(2)));
      }
    },
  }));

  pair.server.send(dataFrame(1, request(1)));
  await flush(clock);
  assert.deepEqual(accepted, [1, 2]);

  // Transfer 2 is now the completed high-water transfer and must be
  // acknowledged without invoking Session.accept a second time.
  pair.server.send(dataFrame(2, request(2)));
  await flush(clock);
  assert.deepEqual(accepted, [1, 2]);
});

test("TR-03 every encoded chunk stays below the outer frame limit", async () => {
  const { clock, pair, left, right } = connectedPair();
  left.bind(receiver());
  right.bind(receiver());
  const message = maxSizedUnicodeMessage();

  const sending = left.send(message);
  await flush(clock);
  await sending;
  const data = pair.client.sent
    .map(frame)
    .filter((candidate) => candidate.kind === "DATA");
  assert.ok(data.length > 1);
  assert.ok(
    data.every(
      (candidate) => textEncoder.encode(JSON.stringify(candidate)).byteLength <= MAX_MESSAGE_BYTES,
    ),
  );

  const unicode = encodedDataFrame(2, request(2, { text: "中文🙂\"\\" }));
  assert.ok(textEncoder.encode(unicode).byteLength > unicode.length);
});

test("TR-04 MAX_QUEUED_MESSAGES counts transfers rather than chunks", async () => {
  const { clock, pair, left, right } = connectedPair();
  left.bind(receiver());
  right.bind(receiver());
  const queued = [];
  for (let id = 1; id <= MAX_QUEUED_MESSAGES; id += 1) {
    queued.push(observe(left.send(request(id, { text: "汉".repeat(40) }))));
  }
  const overflow = await observe(
    left.send(request(MAX_QUEUED_MESSAGES + 1, { text: "汉".repeat(40) })),
  );
  assert.equal(overflow.status, "rejected");
  assert.equal(overflow.error.code, sdkErrorCodes.transportQueueFull);
  assert.equal(overflow.error.delivery, "not_sent");

  const closing = left.close();
  assert.equal(frame(pair.client.sent[0]).kind, "CLOSE");
  await flush(clock);
  await closing;
  await Promise.all(queued);
});

test("TR-04 MAX_QUEUED_BYTES rejects before the logical transfer count", async () => {
  const { clock, pair, left, right } = connectedPair();
  left.bind(receiver());
  right.bind(receiver());

  // One 200 KiB payload now has only four DATA frame snapshots. Their combined
  // size remains slightly above 200 KiB, so the byte budget still wins before
  // the 128-transfer count limit.
  const text = "x".repeat(200_000);
  const pending = [];
  let overflow;
  const probeLimit = Math.min(MAX_QUEUED_MESSAGES, 32);
  for (let requestId = 1; requestId <= probeLimit; requestId += 1) {
    let queueError;
    const raw = left.send(request(requestId, { text }));
    raw.catch((error) => {
      queueError = error;
    });
    const observed = observe(raw);
    pending.push(observed);
    await Promise.resolve();
    await Promise.resolve();
    if (queueError?.code === sdkErrorCodes.transportQueueFull) {
      overflow = queueError;
      break;
    }
  }

  assert.ok(overflow, "the byte budget should reject before the message count");
  assert.ok(pending.length < MAX_QUEUED_MESSAGES);
  assert.ok((pending.length - 1) * 200_000 < MAX_QUEUED_BYTES);

  const closing = left.close();
  await flush(clock);
  await closing;
  await Promise.all(pending);
});

test("TR-12 chunk window sends only its configured number of chunks", async () => {
  const { clock, pair, left, right } = connectedPair({ chunkWindowSize: 2 });
  const accepted = [];
  left.bind(receiver());
  right.bind(receiver({ accept: (message) => accepted.push(message.requestId) }));
  pair.setInterceptor((packet) =>
    packet.kind === "ACK" && packet.direction === "server-to-client"
      ? { drop: true }
      : undefined,
  );

  const sending = left.send(
    request(1, { text: asciiTextSpanningChunks(3) }),
  );
  await flush(clock);
  const initial = pair.client.sent.filter((raw) => frame(raw).kind === "DATA");
  assert.equal(initial.length, 2);
  assert.equal(new Set(initial.map((raw) => frame(raw).transferId)).size, 1);

  pair.client.emit("message", {
    data: JSON.stringify({ kind: "ACK", transferId: 1, chunkIndex: 0 }),
  });
  await flush(clock);
  const afterOneAck = pair.client.sent.filter((raw) => frame(raw).kind === "DATA");
  assert.equal(afterOneAck.length, 3);

  pair.client.emit("message", {
    data: JSON.stringify({ kind: "ACK", transferId: 1, chunkIndex: 1 }),
  });
  pair.client.emit("message", {
    data: JSON.stringify({ kind: "ACK", transferId: 1, chunkIndex: 2 }),
  });
  await flush(clock);
  await sending;
  assert.deepEqual(accepted, [1]);
});

test("TR-12 long transfer advances exactly one chunk per matching ACK", async () => {
  const { clock, pair, left, right } = connectedPair({
    chunkWindowSize: MAX_IN_FLIGHT_CHUNKS,
  });
  const accepted = [];
  left.bind(receiver());
  right.bind(receiver({ accept: (message) => accepted.push(message) }));
  pair.setInterceptor((packet) =>
    packet.kind === "ACK" && packet.direction === "server-to-client"
      ? { drop: true }
      : undefined,
  );

  const message = maxSizedUnicodeMessage();
  const totalChunks = MAX_CHUNKS_PER_TRANSFER;
  const sending = left.send(message);
  await flush(clock);
  const dataCount = () =>
    pair.client.sent.filter((raw) => frame(raw).kind === "DATA").length;
  assert.equal(dataCount(), MAX_IN_FLIGHT_CHUNKS);

  // Wrong ACKs do not consume a window slot.
  pair.client.emit("message", {
    data: JSON.stringify({ kind: "ACK", transferId: 999, chunkIndex: 0 }),
  });
  await flush(clock);
  assert.equal(dataCount(), MAX_IN_FLIGHT_CHUNKS);

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    pair.client.emit("message", {
      data: JSON.stringify({ kind: "ACK", transferId: 1, chunkIndex }),
    });
    await flush(clock);
    assert.equal(
      dataCount(),
      Math.min(totalChunks, MAX_IN_FLIGHT_CHUNKS + chunkIndex + 1),
    );
    if (chunkIndex === 0) {
      pair.client.emit("message", {
        data: JSON.stringify({ kind: "ACK", transferId: 1, chunkIndex }),
      });
      await flush(clock);
      assert.equal(dataCount(), MAX_IN_FLIGHT_CHUNKS + 1);
    }
  }
  await sending;
  assert.deepEqual(accepted, [message]);
});

test("TR-08/TR-09 lost ACK retries identical bytes and receiver accepts once", async () => {
  const { clock, pair, left, right } = connectedPair();
  let accepts = 0;
  left.bind(receiver());
  right.bind(receiver({ accept: () => { accepts += 1; } }));
  let droppedChunkAcks = 0;
  pair.setInterceptor((packet) => {
    if (
      packet.kind === "ACK" &&
      packet.direction === "server-to-client" &&
      frame(packet.data).transferId === 1 &&
      frame(packet.data).chunkIndex === 0 &&
      droppedChunkAcks < 1
    ) {
      droppedChunkAcks += 1;
      return { drop: true };
    }
    return undefined;
  });

  const sending = left.send(request(1));
  await flush(clock);
  assert.equal(accepts, 1);
  clock.advanceBy(ACK_TIMEOUT_MS);
  await flush(clock);
  await sending;

  const data = pair.client.sent
    .map((raw) => ({ raw, parsed: frame(raw) }))
    .filter(({ parsed }) => parsed.kind === "DATA");
  const byChunk = new Map();
  for (const entry of data) {
    const list = byChunk.get(entry.parsed.chunkIndex) ?? [];
    list.push(entry.raw);
    byChunk.set(entry.parsed.chunkIndex, list);
  }
  assert.equal(byChunk.get(0)?.length, 2);
  assert.ok(
    [...byChunk.entries()]
      .filter(([chunkIndex]) => chunkIndex !== 0)
      .every(([, entries]) => entries.length === 1),
  );
  assert.ok([...byChunk.values()].every((entries) => new Set(entries).size === 1));
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
  const transferOne = pair.client.sent
    .map(frame)
    .filter((candidate) => candidate.kind === "DATA" && candidate.transferId === 1);
  const attemptsByChunk = new Map();
  for (const candidate of transferOne) {
    attemptsByChunk.set(
      candidate.chunkIndex,
      (attemptsByChunk.get(candidate.chunkIndex) ?? 0) + 1,
    );
  }
  assert.ok([...attemptsByChunk.values()].every((count) => count === MAX_SEND_ATTEMPTS));
});

test("TR-10 stale and wrong ACKs do not advance the FIFO", async () => {
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

  const a = left.send(request(1));
  const b = left.send(request(2));
  await flush(clock);
  pair.server.send(JSON.stringify({ kind: "ACK", transferId: 999, chunkIndex: 0 }));
  await flush(clock);
  assert.deepEqual(accepted, [1]);

  pair.setInterceptor(undefined);
  pair.server.send(JSON.stringify({ kind: "ACK", transferId: 1, chunkIndex: 0 }));
  pair.server.send(JSON.stringify({ kind: "ACK", transferId: 1, chunkIndex: 1 }));
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

test("invalid chunk indexes, counts, and payload sizes are rejected without ACK", async () => {
  const { clock, pair, left } = connectedPair();
  let accepts = 0;
  left.bind(receiver({ accept: () => { accepts += 1; } }));
  const invalid = [
    { chunkIndex: -1, chunkCount: 2, payload: "x" },
    { chunkIndex: 2, chunkCount: 2, payload: "x" },
    { chunkIndex: 0, chunkCount: 0, payload: "x" },
    {
      chunkIndex: 0,
      chunkCount: MAX_CHUNKS_PER_TRANSFER + 1,
      payload: "x",
    },
    {
      chunkIndex: 0,
      chunkCount: 2,
      payload: "x".repeat(CHUNK_PAYLOAD_BYTES + 1),
    },
  ];
  for (const [index, candidate] of invalid.entries()) {
    pair.server.send(JSON.stringify({
      kind: "DATA",
      transferId: index + 1,
      ...candidate,
    }));
  }
  await flush(clock);

  assert.equal(accepts, 0);
  assert.equal(pair.client.sent.filter((raw) => frame(raw).kind === "ACK").length, 0);
});

test("partial chunk conflicts are dropped; legacy single-frame input remains accepted", async () => {
  const { clock, pair, left } = connectedPair();
  const accepted = [];
  left.bind(receiver({ accept: (message) => accepted.push(message) }));

  const message = request(1, { text: asciiTextSpanningChunks(3) });
  const pieces = chunkPayload(JSON.stringify(message));
  assert.ok(pieces.length >= 3);
  const makeChunk = (chunkIndex, chunkCount = pieces.length, payload = pieces[chunkIndex]) =>
    JSON.stringify({
      kind: "DATA",
      transferId: 10,
      chunkIndex,
      chunkCount,
      payload,
    });

  pair.server.send(makeChunk(0));
  pair.server.send(makeChunk(0, pieces.length, `${pieces[0]}x`));
  pair.server.send(makeChunk(1, pieces.length + 1));
  for (let chunkIndex = 1; chunkIndex < pieces.length; chunkIndex += 1) {
    pair.server.send(makeChunk(chunkIndex));
  }
  await flush(clock);
  assert.deepEqual(accepted, [message]);

  const legacy = request(2, {
    text: "x".repeat(CHUNK_PAYLOAD_BYTES + 100),
  });
  assert.ok(textEncoder.encode(JSON.stringify(legacy)).byteLength > CHUNK_PAYLOAD_BYTES);
  pair.server.send(dataFrame(11, legacy));
  await flush(clock);
  assert.deepEqual(accepted, [message, legacy]);
});

test("reassembled payload byte budget is enforced before JSON delivery", async () => {
  const { clock, pair, left } = connectedPair();
  let accepts = 0;
  left.bind(receiver({ accept: () => { accepts += 1; } }));
  const chunkCount = MAX_CHUNKS_PER_TRANSFER;
  const payload = "x".repeat(CHUNK_PAYLOAD_BYTES - 3);
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    pair.server.send(JSON.stringify({
      kind: "DATA",
      transferId: 20,
      chunkIndex,
      chunkCount,
      payload,
    }));
  }
  await flush(clock);
  assert.equal(accepts, 0);
  const acknowledgements = pair.client.sent
    .map(frame)
    .filter((candidate) => candidate.kind === "ACK" && candidate.transferId === 20);
  assert.equal(
    acknowledgements.some((candidate) => candidate.chunkIndex === chunkCount - 1),
    false,
  );
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

test("TR-16 active AbortSignal stops remaining chunks and B continues", async () => {
  const { clock, pair, left, right } = connectedPair({ chunkWindowSize: 2 });
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
  const a = observe(
    left.send(request(1, { text: asciiTextSpanningChunks(3) }), {
      signal: controller.signal,
    }),
  );
  const b = left.send(request(2));
  await flush(clock);
  const dataBeforeAbort = pair.client.sent
    .map(frame)
    .filter((candidate) => candidate.kind === "DATA" && candidate.transferId === 1)
    .length;
  assert.equal(dataBeforeAbort, 2);
  controller.abort();
  await flush(clock);
  assert.equal(
    pair.client.sent
      .map(frame)
      .filter((candidate) => candidate.kind === "DATA" && candidate.transferId === 1)
      .length,
    dataBeforeAbort,
  );
  assert.equal(clock.pendingTimerCount, 0);

  const result = await a;
  assert.equal(result.status, "rejected");
  assert.ok(result.error instanceof TransportSendCancelledError);
  assert.equal(result.error.delivery, "unknown");
  await b;
  assert.deepEqual(accepted, [2]);
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
