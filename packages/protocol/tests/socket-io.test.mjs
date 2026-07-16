import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Server } from "socket.io";
import {
  protocolVersion,
} from "../dist/definitions/index.js";
import {
  defaultSocketIoChunkPayloadBytes,
  ProtocolSession,
  SocketIoClientTransport,
  SocketIoServerTransport,
} from "../dist/implementations/index.js";

const frameEvent = "protocol:frame";
const frameMagic = 0x5243;
const frameVersion = 1;
const dataFrameKind = 1;
const acknowledgementFrameKind = 2;
const dataFrameHeaderBytes = 28;

class FakeSocketEndpoint {
  connected = false;
  listeners = new Map();

  constructor(pair, side) {
    this.pair = pair;
    this.side = side;
    this.id = `${side}-socket`;
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event, ...args) {
    this.pair.route(this, event, args);
    return true;
  }

  connect() {
    this.pair.connect();
    return this;
  }

  disconnect() {
    this.pair.disconnect();
    return this;
  }

  dispatch(event, ...args) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeSocketPair {
  client = new FakeSocketEndpoint(this, "client");
  server = new FakeSocketEndpoint(this, "server");
  transmissions = [];
  held = [];
  framePolicy = () => "deliver";

  connect() {
    if (this.client.connected) return;
    this.client.connected = true;
    this.server.connected = true;
    queueMicrotask(() => this.client.dispatch("connect"));
  }

  disconnect() {
    if (!this.client.connected && !this.server.connected) return;
    this.client.connected = false;
    this.server.connected = false;
    queueMicrotask(() => {
      this.client.dispatch("disconnect", "io client disconnect");
      this.server.dispatch("disconnect", "client namespace disconnect");
    });
  }

  route(from, event, args) {
    const to = from === this.client ? this.server : this.client;
    const transmission = {
      from: from.side,
      to: to.side,
      event,
      args,
      value: args[0],
    };

    if (event !== frameEvent) {
      queueMicrotask(() => to.dispatch(event, ...args));
      return;
    }

    this.transmissions.push(transmission);
    const action = this.framePolicy(transmission);
    if (action === "hold") {
      this.held.push(transmission);
    } else if (action === "deliver") {
      this.deliver(transmission);
    } else if (action !== "drop") {
      throw new Error(`Unknown fake frame action: ${action}`);
    }
  }

  deliver(transmission) {
    const target = transmission.to === "client" ? this.client : this.server;
    queueMicrotask(() => target.dispatch(transmission.event, ...transmission.args));
  }

  releaseHeld(index = 0) {
    const [transmission] = this.held.splice(index, 1);
    assert.ok(transmission, "expected the fake link to hold a frame");
    this.deliver(transmission);
  }

  releaseAllHeld() {
    for (const transmission of this.held.splice(0)) this.deliver(transmission);
  }
}

const defaultTransportOptions = {
  chunkPayloadBytes: 4,
  sendWindowChunks: 2,
  ackTimeoutMs: 100,
  maxRetransmissions: 2,
  maxMessageBytes: 1_024,
  maxQueuedMessages: 8,
  maxQueuedBytes: 4_096,
};

async function createConnectedTransports(context, optionOverrides = {}) {
  const pair = new FakeSocketPair();
  const options = { ...defaultTransportOptions, ...optionOverrides };
  const client = new SocketIoClientTransport("memory://socket-io", {
    ...options,
    createSocket: () => pair.client,
  });
  const server = new SocketIoServerTransport(pair.server, options);
  const clientConnecting = client.connect();
  await waitFor(
    () => pair.server.connected,
    "fake Socket.IO client did not establish its peer connection",
  );
  await server.connect();
  await clientConnecting;
  context.after(async () => {
    await Promise.allSettled([client.disconnect(), server.disconnect()]);
  });
  return { pair, client, server };
}

function collectMessages(transport) {
  const messages = [];
  transport.subscribe((event) => {
    if (event.type === "message") messages.push(event.message);
  });
  return messages;
}

function frameKind(transmission) {
  assert.equal(transmission.event, frameEvent);
  assert.ok(transmission.value instanceof Uint8Array, "transport frames must be binary");
  assert.ok(transmission.value.byteLength >= 4, "transport frame must include its prefix");
  const view = new DataView(
    transmission.value.buffer,
    transmission.value.byteOffset,
    transmission.value.byteLength,
  );
  assert.equal(view.getUint16(0), frameMagic);
  assert.equal(view.getUint8(2), frameVersion);
  return transmission.value[3];
}

function dataFrameSequence(transmission) {
  assert.equal(frameKind(transmission), dataFrameKind);
  return new DataView(
    transmission.value.buffer,
    transmission.value.byteOffset,
    transmission.value.byteLength,
  ).getUint32(4);
}

function dataFrameMessageId(transmission) {
  assert.equal(frameKind(transmission), dataFrameKind);
  return new DataView(
    transmission.value.buffer,
    transmission.value.byteOffset,
    transmission.value.byteLength,
  ).getUint32(8);
}

function acknowledgementSequence(transmission) {
  assert.equal(frameKind(transmission), acknowledgementFrameKind);
  return new DataView(
    transmission.value.buffer,
    transmission.value.byteOffset,
    transmission.value.byteLength,
  ).getUint32(4);
}

function encodeFixtureDataFrame({
  magic = 0x5243,
  version = 1,
  kind = dataFrameKind,
  frameSequence = 0,
  messageId = 0,
  chunkIndex = 0,
  chunkCount = 1,
  totalMessageBytes = 1,
  declaredPayloadBytes,
  payload = Uint8Array.of(1),
} = {}) {
  const encoded = new Uint8Array(dataFrameHeaderBytes + payload.byteLength);
  const view = new DataView(encoded.buffer);
  view.setUint16(0, magic);
  view.setUint8(2, version);
  view.setUint8(3, kind);
  view.setUint32(4, frameSequence);
  view.setUint32(8, messageId);
  view.setUint32(12, chunkIndex);
  view.setUint32(16, chunkCount);
  view.setUint32(20, totalMessageBytes);
  view.setUint32(24, declaredPayloadBytes ?? payload.byteLength);
  encoded.set(payload, dataFrameHeaderBytes);
  return encoded;
}

function encodeFixtureAcknowledgement(nextExpectedFrameSequence) {
  const encoded = new Uint8Array(8);
  const view = new DataView(encoded.buffer);
  view.setUint16(0, 0x5243);
  view.setUint8(2, 1);
  view.setUint8(3, acknowledgementFrameKind);
  view.setUint32(4, nextExpectedFrameSequence);
  return encoded;
}

function frames(pair, from, kind) {
  return pair.transmissions.filter(
    (transmission) => transmission.from === from && frameKind(transmission) === kind,
  );
}

async function waitFor(predicate, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function settleImmediateTurns(turns = 3) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withTimeout(promise, timeoutMs = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("test operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("Socket.IO transports split DATA frames and expose only a complete reassembled message", async (context) => {
  const { pair, client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 4,
    sendWindowChunks: 3,
  });
  const received = collectMessages(server);
  const message = Uint8Array.from({ length: 17 }, (_, index) => index + 1);

  await client.send(message);
  await waitFor(() => received.length === 1, "server did not receive the reassembled message");

  assert.deepEqual(received, [message]);
  const dataFrames = frames(pair, "client", dataFrameKind);
  const acknowledgements = frames(pair, "server", acknowledgementFrameKind);
  assert.equal(dataFrames.length, Math.ceil(message.byteLength / 4));
  assert.ok(dataFrames.every(({ value }) => value.byteLength <= dataFrameHeaderBytes + 4));
  const firstFrameView = new DataView(
    dataFrames[0].value.buffer,
    dataFrames[0].value.byteOffset,
    dataFrames[0].value.byteLength,
  );
  assert.equal(firstFrameView.getUint16(0), 0x5243);
  assert.equal(firstFrameView.getUint8(2), 1);
  assert.equal(firstFrameView.getUint8(3), dataFrameKind);
  assert.equal(firstFrameView.getUint32(8), 0);
  assert.equal(firstFrameView.getUint32(12), 0);
  assert.equal(firstFrameView.getUint32(16), Math.ceil(message.byteLength / 4));
  assert.equal(firstFrameView.getUint32(20), message.byteLength);
  assert.equal(firstFrameView.getUint32(24), 4);
  assert.equal(acknowledgements.length, dataFrames.length);

  const acknowledgementSequences = acknowledgements.map(acknowledgementSequence);
  assert.ok(
    acknowledgementSequences.every((sequence, index) => index === 0 || sequence > acknowledgementSequences[index - 1]),
    "ACK frames must cumulatively advance the next expected DATA sequence",
  );
  assert.equal(
    acknowledgementSequences.at(-1),
    Math.max(...dataFrames.map(dataFrameSequence)) + 1,
  );
});

test("Socket.IO acknowledges a completed message before reporting an upper-layer listener failure", async (context) => {
  const { client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 1,
  });
  const errors = [];
  server.subscribe((event) => {
    if (event.type === "message") throw new Error("fixture listener failed");
  });
  server.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });

  await withTimeout(client.send(Uint8Array.of(1, 2, 3)));
  await waitFor(() => errors.length === 1, "listener failure was not reported");

  assert.match(errors[0].message, /fixture listener failed/);
  assert.equal(client.state, "connected");
  assert.equal(server.state, "connected");
});

test("Socket.IO DATA and ACK fields use network byte order and fixed wire lengths", async (context) => {
  const { pair, client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 8,
  });
  const received = collectMessages(server);
  const message = Uint8Array.from({ length: 514 }, (_, index) => index & 0xff);

  await withTimeout(client.send(message), 2_000);
  await waitFor(() => received.length === 1, "network-order fixture was not delivered");

  const dataFrames = frames(pair, "client", dataFrameKind);
  const acknowledgements = frames(pair, "server", acknowledgementFrameKind);
  assert.equal(dataFrames.length, 257);
  assert.deepEqual([...dataFrames[0].value.subarray(20, 24)], [0, 0, 2, 2]);
  assert.ok(acknowledgements.every(({ value }) => value.byteLength === 8));
  assert.deepEqual([...acknowledgements.at(-1).value.subarray(4, 8)], [0, 0, 1, 1]);
  assert.equal(acknowledgementSequence(acknowledgements.at(-1)), 257);
});

test("Socket.IO sender keeps at most W unacknowledged DATA frames and fills one released slot", async (context) => {
  const windowChunks = 2;
  const { pair, client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: windowChunks,
    ackTimeoutMs: 60_000,
  });
  const received = collectMessages(server);
  pair.framePolicy = (transmission) => (
    transmission.from === "server" && frameKind(transmission) === acknowledgementFrameKind
      ? "hold"
      : "deliver"
  );

  const sending = client.send(Uint8Array.from({ length: 10 }, (_, index) => index));
  let sendSettled = false;
  void sending.then(
    () => { sendSettled = true; },
    () => { sendSettled = true; },
  );
  void sending.catch(() => {});
  await waitFor(
    () => frames(pair, "client", dataFrameKind).length === windowChunks,
    "sender did not fill its initial window",
  );
  await settleImmediateTurns();
  assert.equal(frames(pair, "client", dataFrameKind).length, windowChunks);
  assert.equal(pair.held.length, windowChunks);
  assert.equal(received.length, 0, "a partial message must not escape the Transport");
  assert.equal(sendSettled, false, "send() must remain pending while DATA frames are unacknowledged");

  pair.releaseHeld(0);
  await waitFor(
    () => frames(pair, "client", dataFrameKind).length === windowChunks + 1,
    "sender did not fill the slot released by a cumulative ACK",
  );
  assert.equal(frames(pair, "client", dataFrameKind).length, windowChunks + 1);
  assert.equal(received.length, 0, "an ACK must not expose a still-incomplete message");

  pair.framePolicy = () => "deliver";
  pair.releaseAllHeld();
  await withTimeout(sending);
  await waitFor(() => received.length === 1, "server did not receive the windowed message");
});

test("Socket.IO window crosses queued messages without changing message order or boundaries", async (context) => {
  const { pair, client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 3,
    ackTimeoutMs: 1_000,
  });
  const received = collectMessages(server);
  const first = Uint8Array.of(1, 2, 3, 4);
  const second = Uint8Array.of(5, 6, 7, 8);
  pair.framePolicy = (transmission) => (
    transmission.from === "server" && frameKind(transmission) === acknowledgementFrameKind
      ? "hold"
      : "deliver"
  );

  const sending = Promise.all([client.send(first), client.send(second)]);
  await waitFor(
    () => frames(pair, "client", dataFrameKind).length === 3,
    "sender did not extend its window into the next queued message",
  );
  const initialData = frames(pair, "client", dataFrameKind);
  assert.deepEqual(initialData.map(dataFrameMessageId), [0, 0, 1]);
  await waitFor(() => received.length === 1, "first complete message was not delivered");
  assert.deepEqual(received, [first]);

  pair.framePolicy = () => "deliver";
  pair.releaseAllHeld();
  await withTimeout(sending);
  await waitFor(() => received.length === 2, "second complete message was not delivered");
  assert.deepEqual(received, [first, second]);
});

test("Socket.IO Go-Back-N recovers from a missing DATA frame", async (context) => {
  const { pair, client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 2,
    ackTimeoutMs: 10,
    maxRetransmissions: 2,
  });
  const received = collectMessages(server);
  let droppedFirstData = false;
  pair.framePolicy = (transmission) => {
    if (
      transmission.from === "client"
      && frameKind(transmission) === dataFrameKind
      && dataFrameSequence(transmission) === 0
      && !droppedFirstData
    ) {
      droppedFirstData = true;
      return "drop";
    }
    return "deliver";
  };

  const message = Uint8Array.of(10, 11, 12, 13);
  await withTimeout(client.send(message));
  await waitFor(() => received.length === 1, "message was not delivered after DATA retransmission");
  assert.deepEqual(frames(pair, "client", dataFrameKind).map(dataFrameSequence), [0, 1, 0, 1]);
  assert.deepEqual(
    frames(pair, "server", acknowledgementFrameKind).map(acknowledgementSequence),
    [0, 1, 2],
    "a gap must repeat the current cumulative ACK before retransmission advances it",
  );
  assert.deepEqual(received, [message]);
});

test("Socket.IO sender retransmits after a lost ACK while receiver delivers the message once", async (context) => {
  const { pair, client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 3,
    sendWindowChunks: 3,
    ackTimeoutMs: 10,
    maxRetransmissions: 2,
  });
  const received = collectMessages(server);
  const message = Uint8Array.from({ length: 9 }, (_, index) => index + 10);
  const chunkCount = Math.ceil(message.byteLength / 3);
  let droppedAcknowledgements = 0;
  pair.framePolicy = (transmission) => {
    if (
      transmission.from === "server"
      && frameKind(transmission) === acknowledgementFrameKind
      && droppedAcknowledgements < chunkCount
    ) {
      droppedAcknowledgements += 1;
      return "drop";
    }
    return "deliver";
  };

  await withTimeout(client.send(message));
  await waitFor(() => received.length === 1, "server did not deliver the message");

  assert.equal(droppedAcknowledgements, chunkCount);
  assert.deepEqual(received, [message]);
  const sequences = frames(pair, "client", dataFrameKind).map(dataFrameSequence);
  assert.deepEqual(sequences, [0, 1, 2, 0, 1, 2], "Go-Back-N must retransmit the entire unacknowledged window");
});

test("Socket.IO transports remain bidirectional with a one-chunk window", async (context) => {
  const { client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 1,
    ackTimeoutMs: 25,
  });
  const receivedByClient = collectMessages(client);
  const receivedByServer = collectMessages(server);
  const fromClient = Uint8Array.of(1, 2, 3, 4, 5, 6, 7);
  const fromServer = Uint8Array.of(20, 21, 22, 23, 24, 25, 26);

  await withTimeout(Promise.all([
    client.send(fromClient),
    server.send(fromServer),
  ]));
  await waitFor(
    () => receivedByClient.length === 1 && receivedByServer.length === 1,
    "bidirectional one-window messages were not delivered",
  );

  assert.deepEqual(receivedByClient, [fromServer]);
  assert.deepEqual(receivedByServer, [fromClient]);
});

test("Socket.IO send rejects after retransmissions are exhausted and does not redeliver", async (context) => {
  const { pair, client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 8,
    sendWindowChunks: 1,
    ackTimeoutMs: 5,
    maxRetransmissions: 1,
  });
  const received = collectMessages(server);
  pair.framePolicy = (transmission) => (
    transmission.from === "server" && frameKind(transmission) === acknowledgementFrameKind
      ? "drop"
      : "deliver"
  );

  const first = client.send(Uint8Array.of(1, 2, 3));
  const queued = client.send(Uint8Array.of(4, 5, 6));
  await Promise.all([
    assert.rejects(
      withTimeout(first),
      /acknowledgement|retransmission|retries|retry|timed out/i,
    ),
    assert.rejects(
      withTimeout(queued),
      /acknowledgement|retransmission|retries|retry|timed out/i,
    ),
  ]);
  await waitFor(() => received.length === 1, "server did not receive the original DATA frame");
  assert.equal(frames(pair, "client", dataFrameKind).length, 2);
  assert.deepEqual(received, [Uint8Array.of(1, 2, 3)]);
  assert.equal(client.state, "error");
  await assert.rejects(client.send(Uint8Array.of(7)), /not connected/i);
});

test("Socket.IO disconnect rejects in-flight and subsequent sends", async (context) => {
  const { pair, client } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 1,
    ackTimeoutMs: 60_000,
  });
  pair.framePolicy = (transmission) => (
    transmission.from === "server" && frameKind(transmission) === acknowledgementFrameKind
      ? "hold"
      : "deliver"
  );

  const firstSending = client.send(Uint8Array.of(1, 2, 3, 4));
  const secondSending = client.send(Uint8Array.of(5, 6, 7, 8));
  const rejectedOnDisconnect = Promise.all([
    assert.rejects(firstSending, /disconnect|connected/i),
    assert.rejects(secondSending, /disconnect|connected/i),
  ]);
  await waitFor(
    () => frames(pair, "client", dataFrameKind).length === 1,
    "sender did not place an in-flight DATA frame on the link",
  );
  await client.disconnect();
  await rejectedOnDisconnect;
  await assert.rejects(client.send(Uint8Array.of(5)), /not connected/i);
});

test("Socket.IO client disconnect synchronously cancels an in-progress connect", async () => {
  const pair = new FakeSocketPair();
  const client = new SocketIoClientTransport("memory://socket-io", {
    ...defaultTransportOptions,
    createSocket: () => pair.client,
  });

  const connecting = client.connect();
  const cancelled = assert.rejects(connecting, /cancelled/i);
  await client.disconnect();
  await cancelled;
  await settleImmediateTurns();

  assert.equal(client.state, "disconnected");
  assert.equal(pair.client.connected, false);
  assert.equal(pair.server.connected, false);
});

test("Socket.IO client honours a synchronous disconnect from its connecting-state listener", async () => {
  const pair = new FakeSocketPair();
  let createdSockets = 0;
  const client = new SocketIoClientTransport("memory://socket-io", {
    ...defaultTransportOptions,
    createSocket: () => {
      createdSockets += 1;
      return pair.client;
    },
  });
  client.subscribe((event) => {
    if (event.type === "state" && event.state === "connecting") {
      void client.disconnect();
    }
  });

  await assert.rejects(client.connect(), /cancelled/i);
  assert.equal(createdSockets, 0);
  assert.equal(client.state, "disconnected");
});

test("Socket.IO client rejects a connection invalidated inside its socket factory", async () => {
  const pair = new FakeSocketPair();
  let client;
  client = new SocketIoClientTransport("memory://socket-io", {
    ...defaultTransportOptions,
    createSocket: () => {
      void client.disconnect();
      return pair.client;
    },
  });

  await assert.rejects(client.connect(), /cancelled/i);
  await settleImmediateTurns();
  assert.equal(client.state, "disconnected");
  assert.equal(pair.client.connected, false);
  assert.equal(pair.server.connected, false);
});

test("Socket.IO client reports connect_error and rejects the pending connection", async () => {
  const pair = new FakeSocketPair();
  pair.client.connect = function connectWithError() {
    queueMicrotask(() => this.dispatch("connect_error", new Error("fixture connect failed")));
    return this;
  };
  const client = new SocketIoClientTransport("memory://socket-io", {
    ...defaultTransportOptions,
    createSocket: () => pair.client,
  });
  const errors = [];
  client.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });

  await assert.rejects(client.connect(), /fixture connect failed/i);
  assert.equal(client.state, "error");
  assert.equal(errors.some((error) => /fixture connect failed/i.test(error.message)), true);
});

test("Socket.IO client cleans up when socket setup throws synchronously", async () => {
  const pair = new FakeSocketPair();
  let disconnectCalls = 0;
  pair.client.connect = function throwingConnect() {
    throw new Error("fixture synchronous connect failure");
  };
  pair.client.disconnect = function recordDisconnect() {
    disconnectCalls += 1;
    return this;
  };
  const client = new SocketIoClientTransport("memory://socket-io", {
    ...defaultTransportOptions,
    connectTimeoutMs: 5,
    createSocket: () => pair.client,
  });

  await assert.rejects(client.connect(), /fixture synchronous connect failure/i);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(client.state, "error");
  assert.equal(disconnectCalls, 1);
});

test("Socket.IO client times out a connection that never settles", async () => {
  const pair = new FakeSocketPair();
  pair.client.connect = function connectWithoutEvents() {
    return this;
  };
  const client = new SocketIoClientTransport("memory://socket-io", {
    ...defaultTransportOptions,
    connectTimeoutMs: 5,
    createSocket: () => pair.client,
  });

  await assert.rejects(client.connect(), /timed out|timed while connecting/i);
  assert.equal(client.state, "error");
  assert.equal(pair.client.connected, false);
});

test("Socket.IO client replaces an in-progress connect without leaking the old socket", async (context) => {
  const pairs = [new FakeSocketPair(), new FakeSocketPair()];
  let created = 0;
  const client = new SocketIoClientTransport("memory://socket-io", {
    ...defaultTransportOptions,
    createSocket: () => pairs[created++].client,
  });
  context.after(() => client.disconnect());
  const events = [];
  client.subscribe((event) => events.push(event));

  const firstConnect = client.connect();
  const firstCancelled = assert.rejects(firstConnect, /cancelled/i);
  const secondConnect = client.connect();
  await firstCancelled;
  await secondConnect;

  assert.equal(created, 2);
  assert.equal(pairs[0].client.connected, false);
  assert.equal(pairs[0].server.connected, false);
  assert.equal(pairs[1].client.connected, true);
  assert.equal(client.state, "connected");

  const eventCount = events.length;
  pairs[0].client.dispatch(frameEvent, encodeFixtureDataFrame());
  pairs[0].client.dispatch("disconnect", "late old disconnect");
  pairs[0].client.dispatch("connect_error", new Error("late old connect error"));
  await settleImmediateTurns();
  assert.equal(events.length, eventCount);
  assert.equal(client.state, "connected");
});

test("Socket.IO server connect is idempotent within one socket connection", async (context) => {
  const { client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 1,
  });
  const received = collectMessages(server);

  await client.send(Uint8Array.of(1, 2));
  await server.connect();
  await client.send(Uint8Array.of(3, 4));
  await waitFor(() => received.length === 2, "server lost sequence state across repeated connect");

  assert.deepEqual(received, [Uint8Array.of(1, 2), Uint8Array.of(3, 4)]);
});

test("Socket.IO server rejects connect when a state listener synchronously disconnects it", async () => {
  const pair = new FakeSocketPair();
  pair.connect();
  const server = new SocketIoServerTransport(pair.server, defaultTransportOptions);
  server.subscribe((event) => {
    if (event.type === "state" && event.state === "connected") {
      void server.disconnect();
    }
  });

  await assert.rejects(server.connect(), /cancelled/i);
  assert.equal(server.state, "disconnected");
  assert.equal(pair.server.connected, false);
});

test("Socket.IO transport enforces complete-message and queued resource limits", async (context) => {
  const { pair, client } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 1,
    ackTimeoutMs: 1_000,
    maxMessageBytes: 8,
    maxQueuedMessages: 1,
    maxQueuedBytes: 4,
  });
  pair.framePolicy = (transmission) => (
    transmission.from === "server" && frameKind(transmission) === acknowledgementFrameKind
      ? "hold"
      : "deliver"
  );

  const first = client.send(Uint8Array.of(1, 2, 3, 4));
  await waitFor(() => pair.held.length > 0, "first message did not enter the ACK window");
  await assert.rejects(client.send(Uint8Array.of(5)), /queued message limit/i);
  await assert.rejects(client.send(Uint8Array.from({ length: 9 })), /exceeds 8 bytes/i);

  pair.framePolicy = () => "deliver";
  pair.releaseAllHeld();
  await withTimeout(first);
});

test("Socket.IO transport enforces its queued byte limit independently", async (context) => {
  const { pair, client } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 1,
    ackTimeoutMs: 1_000,
    maxMessageBytes: 8,
    maxQueuedMessages: 8,
    maxQueuedBytes: 4,
  });
  pair.framePolicy = (transmission) => (
    transmission.from === "server" && frameKind(transmission) === acknowledgementFrameKind
      ? "hold"
      : "deliver"
  );

  const first = client.send(Uint8Array.of(1, 2, 3, 4));
  await waitFor(() => pair.held.length > 0, "first message did not enter the ACK window");
  await assert.rejects(client.send(Uint8Array.of(5)), /queued byte limit/i);

  pair.framePolicy = () => "deliver";
  pair.releaseAllHeld();
  await withTimeout(first);
});

test("Socket.IO transport options cannot raise architectural hard limits", async (context) => {
  const pair = new FakeSocketPair();
  const client = new SocketIoClientTransport("memory://socket-io", {
    ...defaultTransportOptions,
    reassemblyTimeoutMs: 10_001,
    createSocket: () => pair.client,
  });

  await assert.rejects(client.connect(), /reassemblyTimeoutMs must not exceed 10000/i);
  assert.equal(client.state, "error");
  assert.equal(pair.client.connected, false);

  const excessiveAckTimeout = new SocketIoClientTransport("memory://socket-io", {
    ...defaultTransportOptions,
    ackTimeoutMs: 0x8000_0000,
    createSocket: () => pair.client,
  });
  await assert.rejects(excessiveAckTimeout.connect(), /ackTimeoutMs must not exceed 2147483647/i);
  assert.throws(
    () => new SocketIoClientTransport("memory://socket-io", { connectTimeoutMs: 0 }),
    /connectTimeoutMs must be a positive integer/i,
  );
  assert.throws(
    () => new SocketIoClientTransport("memory://socket-io", { connectTimeoutMs: 0x8000_0000 }),
    /connectTimeoutMs must be a positive integer/i,
  );

  const hardLimitCases = [
    ["chunkPayloadBytes", 16 * 1024 + 1, 16 * 1024],
    ["sendWindowChunks", 9, 8],
    ["maxRetransmissions", 4, 3],
    ["maxMessageBytes", 256 * 1024 + 1, 256 * 1024],
    ["maxQueuedMessages", 129, 128],
    ["maxQueuedBytes", 4 * 1024 * 1024 + 1, 4 * 1024 * 1024],
  ];
  for (const [name, value, maximum] of hardLimitCases) {
    await context.test(name, async () => {
      const casePair = new FakeSocketPair();
      const limitedClient = new SocketIoClientTransport("memory://socket-io", {
        [name]: value,
        createSocket: () => casePair.client,
      });
      await assert.rejects(
        limitedClient.connect(),
        new RegExp(`${name} must not exceed ${maximum}`, "i"),
      );
      assert.equal(casePair.client.connected, false);
    });
  }
});

test("Socket.IO max message size can be lower than its chunk payload size", async (context) => {
  const pair = new FakeSocketPair();
  const options = { maxMessageBytes: 2 };
  const client = new SocketIoClientTransport("memory://socket-io", {
    ...options,
    createSocket: () => pair.client,
  });
  const server = new SocketIoServerTransport(pair.server, options);
  const connecting = client.connect();
  await waitFor(() => pair.server.connected, "fake peer did not connect");
  await server.connect();
  await connecting;
  context.after(async () => {
    await Promise.allSettled([client.disconnect(), server.disconnect()]);
  });
  const received = collectMessages(server);

  await client.send(Uint8Array.of(1, 2));
  await waitFor(() => received.length === 1, "small capped message was not delivered");
  assert.deepEqual(received, [Uint8Array.of(1, 2)]);
});

test("Socket.IO transport clears a stalled partial reassembly after its timeout", async (context) => {
  const { pair, client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 2,
    ackTimeoutMs: 100,
    maxRetransmissions: 2,
    reassemblyTimeoutMs: 5,
  });
  const serverErrors = [];
  server.subscribe((event) => {
    if (event.type === "error") serverErrors.push(event.error);
  });
  pair.framePolicy = (transmission) => (
    transmission.from === "client"
    && frameKind(transmission) === dataFrameKind
    && dataFrameSequence(transmission) === 1
      ? "drop"
      : "deliver"
  );

  const sending = client.send(Uint8Array.of(1, 2, 3, 4));
  const rejected = assert.rejects(sending, /disconnect|connected/i);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(
    serverErrors.some((error) => /reassembly timed out/i.test(error.message)),
    true,
    "partial reassembly did not time out",
  );
  await rejected;
  assert.equal(serverErrors.length, 1);
});

test("Socket.IO transport restarts its reassembly timeout after each contiguous chunk", async (context) => {
  const { pair, client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 3,
    ackTimeoutMs: 1_000,
    reassemblyTimeoutMs: 30,
  });
  const received = collectMessages(server);
  const errors = [];
  server.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });
  pair.framePolicy = (transmission) => (
    transmission.from === "client" && frameKind(transmission) === dataFrameKind
      ? "hold"
      : "deliver"
  );

  const sending = client.send(Uint8Array.of(1, 2, 3, 4, 5, 6));
  await waitFor(() => pair.held.length === 3, "sender did not fill the held DATA window");
  pair.releaseHeld();
  await waitFor(
    () => frames(pair, "server", acknowledgementFrameKind).some(
      (frame) => acknowledgementSequence(frame) === 1,
    ),
    "first chunk was not accepted",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  pair.releaseHeld();
  await waitFor(
    () => frames(pair, "server", acknowledgementFrameKind).some(
      (frame) => acknowledgementSequence(frame) === 2,
    ),
    "second chunk was not accepted",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  pair.releaseHeld();

  await withTimeout(sending);
  await waitFor(() => received.length === 1, "message did not complete after timer progress");
  assert.equal(errors.length, 0);
  assert.deepEqual(received, [Uint8Array.of(1, 2, 3, 4, 5, 6)]);
});

test("Socket.IO transport rejects malformed or impossible wire frames", async (context) => {
  const invalidFrames = [
    ["non-binary payload", "not binary"],
    ["magic", encodeFixtureDataFrame({ magic: 0 })],
    ["version", encodeFixtureDataFrame({ version: 2 })],
    ["kind", encodeFixtureDataFrame({ kind: 9 })],
    ["reserved DATA sequence", encodeFixtureDataFrame({ frameSequence: 0xffff_ffff })],
    ["truncated DATA header", Uint8Array.of(0x52, 0x43, 1, dataFrameKind)],
    ["truncated ACK", encodeFixtureAcknowledgement(0).subarray(0, 7)],
    ["oversized ACK", Uint8Array.from([...encodeFixtureAcknowledgement(0), 0])],
    ["payload length", encodeFixtureDataFrame({ declaredPayloadBytes: 2 })],
    ["encoded frame size", encodeFixtureDataFrame({
      totalMessageBytes: 5,
      payload: Uint8Array.of(1, 2, 3, 4, 5),
    })],
    ["chunk index", encodeFixtureDataFrame({ chunkIndex: 1 })],
    ["chunk count", encodeFixtureDataFrame({ chunkCount: 2 })],
    ["message size", encodeFixtureDataFrame({ totalMessageBytes: 1_025 })],
    ["ACK beyond sent range", encodeFixtureAcknowledgement(1)],
  ];

  for (const [name, encoded] of invalidFrames) {
    await context.test(name, async (subtest) => {
      const { pair, server } = await createConnectedTransports(subtest);
      const received = collectMessages(server);
      const events = [];
      server.subscribe((event) => events.push(event));

      pair.client.emit(frameEvent, encoded);
      await waitFor(
        () => events.some((event) => event.type === "error"),
        `${name} frame did not produce a Transport error`,
      );
      assert.equal(received.length, 0);
      assert.ok(events.some((event) => event.type === "state" && event.state === "error"));
    });
  }
});

test("Socket.IO transport rejects all queued sends and partial reassembly after an invalid frame", async (context) => {
  const { pair, client } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 1,
    ackTimeoutMs: 1_000,
  });
  pair.framePolicy = (transmission) => (
    transmission.from === "server" && frameKind(transmission) === acknowledgementFrameKind
      ? "hold"
      : "deliver"
  );

  const first = client.send(Uint8Array.of(1, 2, 3, 4));
  const second = client.send(Uint8Array.of(5, 6, 7, 8));
  const rejected = Promise.all([
    assert.rejects(first, /disconnect|connected/i),
    assert.rejects(second, /disconnect|connected/i),
  ]);
  await waitFor(() => pair.held.length === 1, "partial message did not enter reassembly");
  pair.client.emit(frameEvent, Uint8Array.of(0, 0, 1, dataFrameKind));
  await rejected;
});

test("Socket.IO transport rejects contradictory metadata in consecutive DATA frames", async (context) => {
  const { pair, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 4,
    sendWindowChunks: 1,
  });
  const errors = [];
  server.subscribe((event) => {
    if (event.type === "error") errors.push(event.error);
  });
  pair.framePolicy = (transmission) => (
    transmission.from === "server" && frameKind(transmission) === acknowledgementFrameKind
      ? "drop"
      : "deliver"
  );
  pair.client.emit(frameEvent, encodeFixtureDataFrame({
    frameSequence: 0,
    messageId: 0,
    chunkIndex: 0,
    chunkCount: 2,
    totalMessageBytes: 8,
    payload: Uint8Array.of(1, 2, 3, 4),
  }));
  await waitFor(
    () => frames(pair, "server", acknowledgementFrameKind).some(
      (frame) => acknowledgementSequence(frame) === 1,
    ),
    "first valid chunk was not acknowledged",
  );
  pair.client.emit(frameEvent, encodeFixtureDataFrame({
    frameSequence: 1,
    messageId: 1,
    chunkIndex: 1,
    chunkCount: 2,
    totalMessageBytes: 8,
    payload: Uint8Array.of(5, 6, 7, 8),
  }));
  await waitFor(
    () => errors.some((error) => /inconsistent/i.test(error.message)),
    "contradictory message metadata was not rejected",
  );
});

test("Socket.IO send snapshots the caller buffer before asynchronous window progress", async (context) => {
  const { client, server } = await createConnectedTransports(context, {
    chunkPayloadBytes: 2,
    sendWindowChunks: 1,
  });
  const received = collectMessages(server);
  const source = Uint8Array.of(1, 2, 3, 4, 5, 6);
  const expected = new Uint8Array(source);

  const sending = client.send(source);
  source.fill(99);
  await sending;
  await waitFor(() => received.length === 1, "server did not receive the snapshotted message");

  assert.deepEqual(received, [expected]);
});

test("Socket.IO transports carry a real protocol session over small DATA chunks", async (context) => {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const transportOptions = {
    chunkPayloadBytes: 16,
    sendWindowChunks: 2,
    ackTimeoutMs: 100,
    maxRetransmissions: 2,
  };
  const serverReady = new Promise((resolve, reject) => {
    io.on("connection", (socket) => {
      const session = new ProtocolSession(
        new SocketIoServerTransport(socket, transportOptions),
        { heartbeatIntervalMs: 0 },
      );
      session.handleRequest("session.open", ({ clientName }) => ({
        protocolVersion,
        peer: { id: "server-1", type: "fixture", name: `Hello ${clientName}` },
        capabilities: { methods: ["operation.get"], notifications: ["operation.status"] },
      }));
      session.connect().then(() => resolve(session), reject);
    });
  });

  const transport = new SocketIoClientTransport(url, transportOptions);
  const client = new ProtocolSession(transport, { heartbeatIntervalMs: 0 });
  await client.connect();
  await serverReady;
  const result = await client.request("session.open", { clientName: "Browser" });
  assert.equal(result.peer.name, "Hello Browser");
  assert.equal(transport.state, "connected");
  await client.disconnect();
  assert.equal(transport.state, "disconnected");
});

test("real Socket.IO transports split and reassemble messages above the default 16 KiB chunk", async (context) => {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;
  let serverTransport;
  const serverReady = new Promise((resolve, reject) => {
    io.on("connection", (socket) => {
      serverTransport = new SocketIoServerTransport(socket);
      serverTransport.connect().then(() => resolve(serverTransport), reject);
    });
  });
  const clientTransport = new SocketIoClientTransport(url);
  context.after(async () => {
    await Promise.allSettled([clientTransport.disconnect(), serverTransport?.disconnect()]);
    await io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const receivedByClient = collectMessages(clientTransport);
  await clientTransport.connect();
  await serverReady;
  const receivedByServer = collectMessages(serverTransport);
  const fromClient = Uint8Array.from(
    { length: defaultSocketIoChunkPayloadBytes + 37 },
    (_, index) => index & 0xff,
  );
  const fromServer = Uint8Array.from(
    { length: defaultSocketIoChunkPayloadBytes + 73 },
    (_, index) => (255 - index) & 0xff,
  );

  await withTimeout(Promise.all([
    clientTransport.send(fromClient),
    serverTransport.send(fromServer),
  ]), 2_000);
  await waitFor(
    () => receivedByClient.length === 1 && receivedByServer.length === 1,
    "real Socket.IO did not deliver both default-chunk messages",
  );
  assert.deepEqual(receivedByClient, [fromServer]);
  assert.deepEqual(receivedByServer, [fromClient]);
});
