import assert from "node:assert/strict";
import test from "node:test";
import { HID_PAYLOAD_BYTES, HID_REPORT_BYTES, encodeRelayFrame, splitRelayMessage } from "@remote-input/device-protocol";
import { RelayAgent } from "@remote-input/web-agent-sdk";

class FakeHid { listeners=[]; writes=[]; onData(fn){this.listeners.push(fn); return ()=>{this.listeners=this.listeners.filter(listener=>listener!==fn)}} write(report){this.writes.push(report)} emit(report){for(const fn of this.listeners)fn(report)} }
test("agent reconstructs and processes UTF-8 from vendor HID reports", async () => {
  const hid = new FakeHid(); const received=[];
  new RelayAgent(hid, async text => received.push(text), error => { throw error; });
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
