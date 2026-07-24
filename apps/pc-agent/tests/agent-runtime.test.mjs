import assert from "node:assert/strict";
import test from "node:test";
import { runAgentRuntime } from "../dist/agent-runtime.js";

class Channel {
  dataListener = () => {}; errorListener = () => {}; closed = false;
  onData(listener){this.dataListener=listener} onError(listener){this.errorListener=listener}
  write(){} close(){this.closed=true}
}

test("agent runtime waits for a device and reconnects after HID errors", async () => {
  const abort = new AbortController(); const channels=[]; let attempts=0; const logs=[];
  const running = runAgentRuntime({
    connector:{async open(){ attempts+=1; if(attempts===1)return null; const channel=new Channel(); channels.push(channel); return channel; }},
    processText:async()=>{}, signal:abort.signal, retryMs:1, log:(message)=>logs.push(message), onError:()=>{},
  });
  while(channels.length<1) await new Promise(resolve=>setImmediate(resolve));
  channels[0].errorListener(new Error("unplugged"));
  while(channels.length<2) await new Promise(resolve=>setImmediate(resolve));
  abort.abort(); await running;
  assert.equal(channels[0].closed,true); assert.equal(channels[1].closed,true);
  assert.ok(logs.some(message=>message.startsWith("Waiting")));
  assert.ok(logs.some(message=>message.includes("reconnecting")));
});
