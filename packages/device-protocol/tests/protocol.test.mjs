import assert from "node:assert/strict";
import test from "node:test";
import {
  HID_REPORT_BYTES,
  decodeRelayFrame,
  decodeHidRelayReport,
  encodeRelayFrame,
  RelayReassembler,
  splitRelayMessage,
} from "../dist/index.js";

test("relay frames round-trip arbitrary UTF-8 across out-of-order chunks", () => {
  const bytes = new TextEncoder().encode("hello, 中文 and emoji 🙂".repeat(20));
  const frames = splitRelayMessage(42, bytes, 50).map(encodeRelayFrame).map(decodeRelayFrame).reverse();
  const reassembler = new RelayReassembler();
  let result;
  for (const frame of frames) result = reassembler.accept(frame) ?? result;
  assert.deepEqual(result, bytes);
});

test("relay rejects corruption and ignores duplicate chunks", () => {
  const frames = splitRelayMessage(7, new Uint8Array(80).fill(3), 50).map(encodeRelayFrame);
  const corrupt = frames[0].slice();
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => decodeRelayFrame(corrupt), /CRC/);
  const reassembler = new RelayReassembler();
  assert.equal(reassembler.accept(decodeRelayFrame(frames[0])), undefined);
  assert.equal(reassembler.accept(decodeRelayFrame(frames[0])), undefined);
  assert.deepEqual(reassembler.accept(decodeRelayFrame(frames[1])), new Uint8Array(80).fill(3));
  assert.equal(reassembler.accept(decodeRelayFrame(frames[0])), undefined);
  assert.equal(reassembler.accept(decodeRelayFrame(frames[1])), undefined);
});

test("reassembler accepts a lower transfer ID from a new link while retaining duplicate suppression", () => {
  const reassembler = new RelayReassembler();
  const high = splitRelayMessage(4_000_000_000, new Uint8Array([1]), 48)[0];
  const low = splitRelayMessage(3, new Uint8Array([2]), 48)[0];
  assert.deepEqual(reassembler.accept(high), new Uint8Array([1]));
  assert.deepEqual(reassembler.accept(low), new Uint8Array([2]));
  assert.equal(reassembler.accept(high), undefined);
});

test("vendor HID reports carry a padded relay frame with or without a report ID", () => {
  const frame = splitRelayMessage(
    100,
    new TextEncoder().encode("WebHID 直传🙂"),
    48,
  )[0];
  const report = new Uint8Array(HID_REPORT_BYTES);
  report.set(encodeRelayFrame(frame));
  assert.deepEqual(decodeHidRelayReport(report), frame);

  const nodeHidReport = new Uint8Array(HID_REPORT_BYTES + 1);
  nodeHidReport.set(report, 1);
  assert.deepEqual(decodeHidRelayReport(nodeHidReport), frame);
  assert.throws(
    () => decodeHidRelayReport(report.subarray(0, HID_REPORT_BYTES - 1)),
    /exactly 64 bytes/,
  );
});
