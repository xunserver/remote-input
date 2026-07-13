import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketTransport } from "../dist/index.js";

class TestWebSocket {
  readyState = 0;
  binaryType = "blob";
  sent = [];
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  dispatch(type, data) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(type === "message" ? { data } : {});
    }
  }
}

class DeferredBlob extends Blob {
  constructor(byte) {
    super();
    this.byte = byte;
    this.promise = new Promise((resolve) => {
      this.resolveBuffer = () => resolve(Uint8Array.of(this.byte).buffer);
    });
  }

  arrayBuffer() {
    return this.promise;
  }

  resolve() {
    this.resolveBuffer();
  }
}

test("WebSocketTransport behaves as a binary duplex message pipe", async () => {
  const socket = new TestWebSocket();
  const transport = new WebSocketTransport("ws://fixture/ws", {
    createWebSocket: () => socket,
  });
  const events = [];
  transport.subscribe((event) => events.push(event));

  const connecting = transport.connect();
  await Promise.resolve();
  socket.readyState = 1;
  socket.dispatch("open");
  await connecting;

  assert.equal(socket.binaryType, "arraybuffer");
  assert.equal(transport.state, "connected");

  await transport.send(new Uint8Array([1, 2, 3]));
  assert.ok(socket.sent[0] instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(socket.sent[0])], [1, 2, 3]);

  socket.dispatch("message", new Uint8Array([4, 5]).buffer);
  await Promise.resolve();
  const messageEvent = events.find((event) => event.type === "message");
  assert.deepEqual([...messageEvent.message], [4, 5]);
});

test("WebSocketTransport rejects a connection interrupted by disconnect", async () => {
  const socket = new TestWebSocket();
  const transport = new WebSocketTransport("ws://fixture/ws", {
    createWebSocket: () => socket,
    connectTimeoutMs: 20,
  });

  const connecting = transport.connect();
  await Promise.resolve();
  await transport.disconnect();

  await assert.rejects(connecting, /disconnected/);
  assert.equal(transport.state, "disconnected");
});

test("WebSocketTransport reports connection timeout and ignores open after an error", async () => {
  const timeoutSocket = new TestWebSocket();
  const timeoutTransport = new WebSocketTransport("ws://fixture/ws", {
    createWebSocket: () => timeoutSocket,
    connectTimeoutMs: 1,
  });
  await assert.rejects(timeoutTransport.connect(), /Timed out/);
  assert.equal(timeoutTransport.state, "error");

  const errorSocket = new TestWebSocket();
  const errorTransport = new WebSocketTransport("ws://fixture/ws", {
    createWebSocket: () => errorSocket,
  });
  const states = [];
  errorTransport.subscribe((event) => {
    if (event.type === "state") {
      states.push(event.state);
    }
  });

  const connecting = errorTransport.connect();
  await Promise.resolve();
  errorSocket.dispatch("error");
  await assert.rejects(connecting);
  errorSocket.readyState = 1;
  errorSocket.dispatch("open");

  assert.equal(errorTransport.state, "error");
  assert.deepEqual(states, ["connecting", "error"]);
});

test("WebSocketTransport preserves Blob message order and drops stale decoded messages", async () => {
  const firstSocket = new TestWebSocket();
  const secondSocket = new TestWebSocket();
  const sockets = [firstSocket, secondSocket];
  const transport = new WebSocketTransport("ws://fixture/ws", {
    createWebSocket: () => sockets.shift(),
  });
  const messages = [];
  transport.subscribe((event) => {
    if (event.type === "message") {
      messages.push(event.message[0]);
    }
  });

  const firstConnection = transport.connect();
  await Promise.resolve();
  firstSocket.readyState = 1;
  firstSocket.dispatch("open");
  await firstConnection;

  const first = new DeferredBlob(1);
  const second = new DeferredBlob(2);
  firstSocket.dispatch("message", first);
  firstSocket.dispatch("message", second);
  second.resolve();
  await Promise.resolve();
  assert.deepEqual(messages, []);

  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [1, 2]);

  const stale = new DeferredBlob(3);
  firstSocket.dispatch("message", stale);
  const secondConnection = transport.connect();
  await Promise.resolve();
  secondSocket.readyState = 1;
  secondSocket.dispatch("open");
  await secondConnection;
  stale.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [1, 2]);
});
