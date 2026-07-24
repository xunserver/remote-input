import assert from "node:assert/strict";
import test from "node:test";
import { HID_PAYLOAD_BYTES, RelayReassembler, decodeRelayFrame, encodeRelayFrame, splitRelayMessage } from "@remote-copy/device-protocol";
import { RelayAgent } from "../dist/relay-agent.js";

class FakeHid { listeners=[]; writes=[]; onData(fn){this.listeners.push(fn)} write(report){this.writes.push(report)} close(){} emit(report){for(const fn of this.listeners)fn(report)} }
test("agent reconstructs UTF-8, processes it, and returns a Session response", async () => {
  const hid = new FakeHid(); const received=[];
  new RelayAgent(hid, async text => received.push(text), error => { throw error; });
  const request = new TextEncoder().encode(JSON.stringify({type:"request",requestId:9,method:"sendText",payload:{text:"中文🙂"}}));
  for (const frame of splitRelayMessage(1, request, HID_PAYLOAD_BYTES)) {
    const report = new Uint8Array(64); report.set(encodeRelayFrame(frame)); hid.emit(report);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received,["中文🙂"]);
  const reassembler=new RelayReassembler(); let response;
  for(const report of hid.writes) response=reassembler.accept(decodeRelayFrame(Uint8Array.from(report).subarray(1)))??response;
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response)),{type:"response",requestId:9,ok:true,data:{pasted:true}});
});
