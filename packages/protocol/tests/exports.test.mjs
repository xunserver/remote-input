import assert from "node:assert/strict";
import test from "node:test";
import * as definitions from "../dist/index.js";
import * as implementations from "../dist/implementations/index.js";

test("protocol public entries keep definitions and implementations separate", () => {
  assert.equal(definitions.protocolVersion, 1);
  assert.equal("ProtocolSession" in definitions, false);
  assert.equal("JsonMessageCodec" in definitions, false);
  assert.equal("SocketIoClientTransport" in definitions, false);

  assert.equal(typeof implementations.ProtocolSession, "function");
  assert.equal(typeof implementations.JsonMessageCodec, "function");
  assert.equal(typeof implementations.SocketIoClientTransport, "function");
  assert.equal("SocketIoFragmentController" in implementations, false);
  assert.equal("protocolVersion" in implementations, false);
});
