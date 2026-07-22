import assert from "node:assert/strict";
import test from "node:test";
import { getConfig } from "../dist/config.js";
import {
  createInputProcessor,
  printReceivedText,
} from "../dist/input/inputProcessor.js";
import { writeClipboardAndPaste } from "../dist/os/clipboard.js";

test("server defaults to print mode and accepts explicit paste mode", () => {
  assert.equal(getConfig({}).inputMode, "print");
  assert.equal(getConfig({}).protocolTraceLevel, undefined);
  assert.equal(getConfig({ INPUT_MODE: "print" }).inputMode, "print");
  assert.equal(getConfig({ INPUT_MODE: "paste" }).inputMode, "paste");
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
  for (const inputMode of ["", "log", "true", "PASTE"]) {
    assert.throws(
      () => getConfig({ INPUT_MODE: inputMode }),
      /INPUT_MODE must be "print" or "paste"/,
    );
  }
});

test("input mode selects printing unless real paste is explicitly enabled", () => {
  assert.equal(createInputProcessor("print"), printReceivedText);
  assert.equal(createInputProcessor("paste"), writeClipboardAndPaste);
});

test("print processor logs an unambiguous representation of received text", async () => {
  const messages = [];
  const text = "first line\nsecond line\u001b[31m";

  await printReceivedText(text, (message) => messages.push(message));

  assert.deepEqual(messages, [`Received text: ${JSON.stringify(text)}`]);
});
