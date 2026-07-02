const assert = require("node:assert/strict");

const {
  RIB32_CHUNK_BYTES,
  base32Decode,
  base32Encode,
  crc32,
  createRib32DecoderState,
  formatRib32Frames,
  getRib32LineErrors,
  getRib32Tasks,
  ingestRib32Text,
} = require("../src/base32Frame.ts");

const encoder = new TextEncoder();

function decodeTask(lines) {
  const state = createRib32DecoderState();
  ingestRib32Text(state, `${lines.join("\n")}\n`);
  return getRib32Tasks(state)[0];
}

function hex32(value) {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function makeChunkLine(taskId, index, total, bytes) {
  return `<RIB32:1:${taskId}:${index}:${total}:${hex32(crc32(bytes))}:${base32Encode(bytes)}>`;
}

function makeEndLine(taskId, bytes) {
  return `</RIB32:1:${taskId}:${hex32(crc32(bytes))}>`;
}

{
  const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 250, 255]);
  const encoded = base32Encode(bytes);
  assert.equal(encoded, "AAAQEAYEAX5P6");
  assert.deepEqual(Array.from(base32Decode(encoded)), Array.from(bytes));
  assert.deepEqual(Array.from(base32Decode(encoded.toLowerCase())), Array.from(bytes));
}

{
  assert.equal(crc32(encoder.encode("123456789")).toString(16).toUpperCase(), "CBF43926");
}

{
  const text = "中文 English 😀\n第二行";
  const lines = formatRib32Frames(7, encoder.encode(text));
  assert.match(lines[0], /^<RIB32:1:7:0:\d+:[0-9A-F]{8}:[A-Z2-7]+>$/);
  assert.match(lines.at(-1), /^<\/RIB32:1:7:[0-9A-F]{8}>$/);
  const task = decodeTask(lines);
  assert.equal(task.taskId, 7);
  assert.equal(task.status, "complete");
  assert.equal(task.decodedText, text);
  assert.deepEqual(task.errors, []);
}

{
  const lines = formatRib32Frames(8, new Uint8Array());
  assert.equal(lines.length, 2);
  const task = decodeTask(lines);
  assert.equal(task.status, "complete");
  assert.equal(task.decodedText, "");
}

{
  const bytes = new Uint8Array(RIB32_CHUNK_BYTES * 2 + 1);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
  const lines = formatRib32Frames(9, bytes);
  const state = createRib32DecoderState();
  ingestRib32Text(state, `${lines[1]}\n${lines[0]}\n${lines[2]}\n${lines[3]}\n`);
  const task = getRib32Tasks(state)[0];
  assert.equal(task.status, "complete");
  assert.deepEqual(Array.from(task.decodedBytes), Array.from(bytes));
}

{
  const lines = formatRib32Frames(10, encoder.encode("一二三四五六七八九十"));
  const damaged = [...lines];
  damaged[0] = damaged[0].replace(/[A-Z2-7](?=>)/, "A");
  const task = decodeTask(damaged);
  assert.equal(task.status, "error");
  assert.match(task.errors.join("\n"), /chunk 0/i);
  assert.equal(task.decodedText, undefined);
}

{
  const lines = formatRib32Frames(11, encoder.encode("missing chunk ".repeat(8)));
  const task = decodeTask([lines[0], lines.at(-1)]);
  assert.equal(task.status, "error");
  assert.match(task.errors.join("\n"), /missing chunk 1/i);
}

{
  const firstChunk = Uint8Array.from({ length: RIB32_CHUNK_BYTES - 1 }, (_, index) => index);
  const secondChunk = Uint8Array.from([RIB32_CHUNK_BYTES - 1]);
  const bytes = new Uint8Array(RIB32_CHUNK_BYTES);
  bytes.set(firstChunk, 0);
  bytes.set(secondChunk, firstChunk.length);
  const task = decodeTask([
    makeChunkLine(12, 0, 2, firstChunk),
    makeChunkLine(12, 1, 2, secondChunk),
    makeEndLine(12, bytes),
  ]);
  assert.equal(task.status, "error");
  assert.match(task.errors.join("\n"), /chunk 0/i);
  assert.match(task.errors.join("\n"), /length/i);
}

{
  const valid = formatRib32Frames(12, encoder.encode("duplicate chunk ".repeat(4)));
  const state = createRib32DecoderState();
  ingestRib32Text(state, `${valid[0].replace(/:0:/, ":0:").replace(/[A-Z2-7](?=>)/, "A")}\n`);
  ingestRib32Text(state, `${valid.join("\n")}\n`);
  const task = getRib32Tasks(state)[0];
  assert.equal(task.status, "complete");
}

{
  const a = formatRib32Frames(13, encoder.encode("A".repeat(40)));
  const b = formatRib32Frames(13, encoder.encode("B".repeat(40)));
  const task = decodeTask([a[0], b[0], a.at(-1)]);
  assert.equal(task.status, "error");
  assert.match(task.errors.join("\n"), /conflict/i);
}

{
  const bytes = Uint8Array.from({ length: RIB32_CHUNK_BYTES }, (_, index) => index);
  const task = decodeTask([
    makeChunkLine(14, 1, 1, bytes),
    makeEndLine(14, bytes),
  ]);
  assert.equal(task.status, "error");
  assert.match(task.errors.join("\n"), /chunk 1/i);
  assert.match(task.errors.join("\n"), /index/i);
}

{
  const valid = formatRib32Frames(15, encoder.encode("footer conflict"));
  const differentFooter = makeEndLine(15, encoder.encode("different footer"));
  const task = decodeTask([valid[0], valid.at(-1), valid.at(-1), differentFooter]);
  assert.equal(task.status, "error");
  assert.match(task.errors.join("\n"), /message crc conflict/i);
}

{
  const linesA = formatRib32Frames(16, encoder.encode("第一段"));
  const linesB = formatRib32Frames(17, encoder.encode("第二段"));
  const state = createRib32DecoderState();
  ingestRib32Text(state, `${linesA.join("\n")}\n${linesB.join("\n")}\n`);
  const tasks = getRib32Tasks(state);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].decodedText, "第一段");
  assert.equal(tasks[1].decodedText, "第二段");
}

{
  const state = createRib32DecoderState();
  ingestRib32Text(state, "<RIB32:1:18:0:oops>\n");
  assert.deepEqual(getRib32LineErrors(state), ["unrecognized line 1"]);
  assert.deepEqual(getRib32Tasks(state), []);
}

{
  const state = createRib32DecoderState();
  ingestRib32Text(state, "<RIB32:1:0:0:1:00000000:>\n");
  assert.deepEqual(getRib32LineErrors(state), ["line 1 invalid task id 0"]);
  assert.deepEqual(getRib32Tasks(state), []);
}

{
  const state = createRib32DecoderState();
  ingestRib32Text(state, "</RIB32:1:0:00000000>\n");
  assert.deepEqual(getRib32LineErrors(state), ["line 1 invalid task id 0"]);
  assert.deepEqual(getRib32Tasks(state), []);
}
