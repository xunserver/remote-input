import assert from "node:assert/strict";
import test from "node:test";
import { JsonMessageCodec, ProtocolValidationError } from "../dist/implementations/index.js";

const codec = new JsonMessageCodec();
const encoder = new TextEncoder();

test("JsonMessageCodec round-trips all envelope kinds", () => {
  const messages = [
    { v: 1, kind: "request", requestId: "request-1", method: "operation.get", body: { operationId: "op-1" } },
    { v: 1, kind: "response", requestId: "request-1", ok: true, body: { operationId: "op-1" } },
    { v: 1, kind: "response", requestId: "request-2", ok: false, error: { code: "failed", message: "no", retryable: false } },
    {
      v: 1,
      kind: "notification",
      name: "operation.status",
      body: { operationId: "op-1", revision: 1, state: "processing", stage: "copying", progress: 20, message: "copying" },
    },
    { v: 1, kind: "ping", heartbeatId: "heartbeat-1" },
    { v: 1, kind: "pong", heartbeatId: "heartbeat-1" },
  ];

  for (const message of messages) {
    assert.deepEqual(codec.decode(codec.encode(message)), message);
  }
});

test("JsonMessageCodec rejects invalid envelopes and bodies", () => {
  const invalid = [
    { v: 2, kind: "ping", heartbeatId: "heartbeat-1" },
    { v: 1, kind: "request", requestId: "", method: "operation.get", body: { operationId: "op-1" } },
    { v: 1, kind: "notification", name: "unknown", body: {} },
    { v: 1, kind: "notification", name: "session.peers", body: { count: 2, peers: [] } },
    {
      v: 1,
      kind: "notification",
      name: "operation.status",
      body: { operationId: "op-1", revision: 1, state: "processing", stage: "copying", progress: 101, message: "bad" },
    },
    { v: 1, kind: "pong", heartbeatId: "" },
  ];

  for (const message of invalid) {
    assert.throws(() => codec.decode(encoder.encode(JSON.stringify(message))), ProtocolValidationError);
  }
});

test("JsonMessageCodec rejects malformed JSON and oversized messages", () => {
  assert.throws(() => codec.decode(encoder.encode("{")), ProtocolValidationError);
  const smallCodec = new JsonMessageCodec({ maxMessageBytes: 8 });
  assert.throws(() => smallCodec.decode(encoder.encode("123456789")), /exceeds 8 bytes/);
});
