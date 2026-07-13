import assert from "node:assert/strict";
import test from "node:test";
import { JsonProtocolCodec } from "../dist/index.js";

const encoder = new TextEncoder();
const codec = new JsonProtocolCodec();

test("JsonProtocolCodec validates protocol version and envelope", () => {
  assert.throws(() => codec.decode(encoder.encode(JSON.stringify({
    v: 2,
    kind: "request",
    id: "request-1",
    method: "session.open",
    body: { clientName: "Browser" },
  }))));

  assert.throws(() => codec.decode(encoder.encode(JSON.stringify({
    v: 1,
    kind: "unknown",
  }))));
});

test("JsonProtocolCodec rejects malformed operation events", () => {
  assert.throws(() => codec.decode(encoder.encode(JSON.stringify({
    v: 1,
    kind: "event",
    name: "operation.status",
    body: {
      operationId: "operation-1",
      revision: 1,
      state: "processing",
      stage: "copying",
      progress: 101,
      message: "invalid progress",
    },
  }))));
});

test("JsonProtocolCodec reports malformed JSON as a protocol validation error", () => {
  assert.throws(
    () => codec.decode(encoder.encode("{")),
    (error) => error.name === "ProtocolValidationError",
  );
});
