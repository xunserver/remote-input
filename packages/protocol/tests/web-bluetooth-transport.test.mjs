import assert from "node:assert/strict";
import test from "node:test";
import { RelayReassembler, decodeRelayFrame, encodeRelayFrame, splitRelayMessage } from "@remote-copy/device-protocol";
import { getWebBluetoothSupport, WebBluetoothTransport } from "../dist/web-bluetooth-transport.js";

class Characteristic {
  listeners = new Set(); writes = []; value;
  async startNotifications(){ return this; }
  async writeValueWithResponse(value){ this.writes.push(new Uint8Array(value)); }
  addEventListener(_type, listener){ this.listeners.add(listener); }
  removeEventListener(_type, listener){ this.listeners.delete(listener); }
  emit(value){ this.value=new DataView(value.buffer,value.byteOffset,value.byteLength); for(const listener of this.listeners)listener({target:this}); }
}

test("Web Bluetooth transport sends relay frames and accepts a reassembled response", async () => {
  const write = new Characteristic(); const notify = new Characteristic(); const deviceListeners=new Set();
  const device = { gatt: { connected:true, async connect(){return {async getPrimaryService(){return {async getCharacteristic(uuid){return uuid.includes("0002")?write:notify;}}}}}, disconnect(){} }, addEventListener(_t,l){deviceListeners.add(l)}, removeEventListener(_t,l){deviceListeners.delete(l)} };
  const transport = new WebBluetoothTransport(async()=>device); const accepted=[];
  transport.bind({accept(value){accepted.push(value)},disconnected(){},localClosed(){},peerClosed(){}});
  await transport.connect();
  const request={type:"request",requestId:1,method:"sendText",payload:{text:"中文🙂".repeat(40)}};
  await transport.send(request);
  assert.ok(write.writes.length>1);
  const reassembler=new RelayReassembler(); let sent;
  for(const raw of write.writes) sent=reassembler.accept(decodeRelayFrame(raw))??sent;
  assert.deepEqual(JSON.parse(new TextDecoder().decode(sent)),request);
  const response=new TextEncoder().encode(JSON.stringify({type:"response",requestId:1,ok:true,data:{pasted:true}}));
  for(const frame of splitRelayMessage(9,response,48)) notify.emit(encodeRelayFrame(frame));
  assert.deepEqual(accepted,[{type:"response",requestId:1,ok:true,data:{pasted:true}}]);
});

test("Web Bluetooth support distinguishes insecure pages from unsupported browsers", () => {
  const bluetooth = { requestDevice: async () => { throw new Error("unused"); } };
  assert.deepEqual(getWebBluetoothSupport({ isSecureContext: false, bluetooth }), { supported: false, reason: "insecure_context" });
  assert.deepEqual(getWebBluetoothSupport({ isSecureContext: true, bluetooth: undefined }), { supported: false, reason: "unavailable" });
  assert.deepEqual(getWebBluetoothSupport({ isSecureContext: true, bluetooth }), { supported: true });
});
