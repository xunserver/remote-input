const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("web/ai-input-sdk.js", "utf8");
const context = {
  window: {},
  navigator: {},
  TextEncoder,
  DataView,
  ArrayBuffer,
  Uint8Array,
  console,
};
vm.createContext(context);
vm.runInContext(source, context);

const internals = context.window.AIInput._internals;

{
  const frame = internals.encodeControlFrame(1, 7, 16, 2);
  assert.equal(frame.byteLength, 12);
  assert.deepEqual(Array.from(frame), [1, 1, 7, 0, 16, 0, 0, 0, 2, 0, 0, 0]);
}

{
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const chunks = internals.createDataFrames(9, bytes);
  assert.equal(chunks.length, 1);
  assert.deepEqual(Array.from(chunks[0]), [1, 16, 9, 0, 0, 0, 1, 0, 1, 2, 3, 4, 5]);
}

{
  const bytes = new Uint8Array(25);
  const chunks = internals.createDataFrames(3, bytes);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].byteLength, 20);
  assert.equal(chunks[1].byteLength, 20);
  assert.equal(chunks[2].byteLength, 9);
}

{
  const frame = new Uint8Array([1, 2, 12, 0, 0, 0, 0, 4, 0, 0, 0, 16, 0, 0]);
  const status = internals.decodeStatusFrame(frame.buffer);
  assert.deepEqual(status, {
    state: "typing",
    lastTaskId: 12,
    lastErrorCode: 0,
    receivedBytes: 1024,
    totalBytes: 4096,
  });
}

console.log("sdk protocol tests passed");
