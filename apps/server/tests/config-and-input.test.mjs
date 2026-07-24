import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import http from "node:http";
import { getConfig } from "../dist/config.js";
import {
  createInputProcessor,
  printReceivedText,
} from "../dist/input/inputProcessor.js";
import { writeClipboardAndPaste } from "../dist/os/clipboard.js";
import { createStaticHandler } from "../dist/http/staticServer.js";

test("server defaults to paste mode and accepts explicit dev mode", () => {
  assert.equal(getConfig({}).inputMode, "paste");
  assert.equal(getConfig({}).protocolTraceLevel, undefined);
  assert.equal(getConfig({ INPUT_MODE: "paste" }).inputMode, "paste");
  assert.equal(getConfig({ INPUT_MODE: "dev" }).inputMode, "dev");
});

test("server protocol trace is explicit and validates its level", () => {
  assert.equal(getConfig({ PROTOCOL_DEBUG: "summary" }).protocolTraceLevel, "summary");
  assert.equal(getConfig({ PROTOCOL_DEBUG: "1" }).protocolTraceLevel, "summary");
  assert.equal(getConfig({ PROTOCOL_DEBUG: "chunks" }).protocolTraceLevel, "chunks");
  assert.equal(getConfig({ PROTOCOL_DEBUG: "off" }).protocolTraceLevel, undefined);
  assert.throws(
    () => getConfig({ PROTOCOL_DEBUG: "verbose" }),
    /Protocol trace level must be/,
  );
});

test("server rejects invalid input modes", () => {
  for (const inputMode of ["", "print", "log", "true", "PASTE"]) {
    assert.throws(
      () => getConfig({ INPUT_MODE: inputMode }),
      /INPUT_MODE must be "paste" or "dev"/,
    );
  }
});

test("dev mode prints while paste mode performs real paste", () => {
  assert.equal(createInputProcessor("dev"), printReceivedText);
  assert.equal(createInputProcessor("paste"), writeClipboardAndPaste);
});

test("print processor logs an unambiguous representation of received text", async () => {
  const messages = [];
  const text = "first line\nsecond line\u001b[31m";

  await printReceivedText(text, (message) => messages.push(message));

  assert.deepEqual(messages, [`Received text: ${JSON.stringify(text)}`]);
});

test("server exposes the built WebHID receiver at /receive and /receive/", async (context) => {
  const config = getConfig({ HOST: "127.0.0.1" });
  const handler = createStaticHandler(config, () => 0);
  const server = http.createServer((request, response) => {
    handler(request, response).catch(context.assert.fail);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  for (const path of ["/receive", "/receive/"]) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await response.text(), /<title>远程接收<\/title>/);
  }
});
