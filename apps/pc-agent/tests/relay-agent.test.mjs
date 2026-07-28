import assert from "node:assert/strict";
import test from "node:test";
import { HID_PAYLOAD_BYTES, HID_REPORT_BYTES, RelayReassembler, decodeHidRelayReport, encodeRelayFrame, splitRelayMessage } from "@remote-input/device-protocol";
import { RelayAgent } from "@remote-input/web-agent-sdk";

class FakeHid { listeners=[]; writes=[]; onData(fn){this.listeners.push(fn); return ()=>{this.listeners=this.listeners.filter(listener=>listener!==fn)}} send(report){this.writes.push(report)} emit(report){for(const fn of this.listeners)fn(report)} }
test("agent reconstructs and processes UTF-8 from vendor HID reports", async () => {
  const hid = new FakeHid(); const received=[];
  new RelayAgent(hid, async command => received.push(command.text), error => { throw error; });
  const request = new TextEncoder().encode(JSON.stringify({type:"request",requestId:9,method:"sendText",payload:{text:"中文🙂"}}));
  for (const frame of splitRelayMessage(1, request, HID_PAYLOAD_BYTES)) {
    const report = new Uint8Array(HID_REPORT_BYTES);
    report.set(encodeRelayFrame(frame));
    hid.emit(report);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received,["中文🙂"]);
  assert.deepEqual(hid.writes, []);
});

test("agent sends receiver status back as a one-way HID notification", async () => {
  const hid = new FakeHid();
  new RelayAgent(hid, async (command, _context, onStatus) => {
    onStatus({
      operationId: command.operationId,
      stage: "succeeded",
      progress: 100,
      message: "done",
    });
  }, error => { throw error; });
  const request = new TextEncoder().encode(JSON.stringify({
    type: "notify",
    method: "sendText",
    payload: {
      text: "copy",
      operationId: "op-1",
      control: { paste: false, restoreClipboard: true },
    },
  }));
  for (const frame of splitRelayMessage(2, request, HID_PAYLOAD_BYTES)) {
    const report = new Uint8Array(HID_REPORT_BYTES);
    report.set(encodeRelayFrame(frame));
    hid.emit(report);
  }
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const reassembler = new RelayReassembler();
  let complete;
  for (const report of hid.writes) {
    complete = reassembler.accept(decodeHidRelayReport(report)) ?? complete;
  }
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(complete)),
    {
      type: "notify",
      method: "inputStatus",
      payload: {
        operationId: "op-1",
        stage: "succeeded",
        progress: 100,
        message: "done",
      },
    },
  );
});
