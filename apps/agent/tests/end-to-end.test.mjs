import assert from "node:assert/strict";
import test from "node:test";
import { HID_REPORT_BYTES } from "@remote-copy/device-protocol";
import {
  REMOTE_COPY_BLE_WRITE,
  WebBluetoothTransport,
} from "@remote-copy/protocol";
import { Client } from "@remote-copy/sdk";
import { RelayAgent } from "@remote-copy/agent-sdk";

class NotificationCharacteristic {
  listeners = new Set();
  value;
  async startNotifications() { return this; }
  addEventListener(_type, listener) { this.listeners.add(listener); }
  removeEventListener(_type, listener) { this.listeners.delete(listener); }
  emit(bytes) {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const listener of this.listeners) listener({ target: this });
  }
}

class SimulatedEspRelay {
  hidDataListener = () => {};
  notify = new NotificationCharacteristic();
  write = {
    startNotifications: async () => this.write,
    addEventListener() {},
    removeEventListener() {},
    writeValueWithResponse: async (value) => {
      const frame = new Uint8Array(value);
      const hidReport = new Uint8Array(HID_REPORT_BYTES);
      hidReport.set(frame);
      this.hidDataListener(hidReport);
    },
  };
  hid = {
    onData: (listener) => { this.hidDataListener = listener; return () => { this.hidDataListener = () => {}; }; },
    write: (wireReport) => {
      const payloadLength = wireReport[12] | (wireReport[13] << 8);
      this.notify.emit(wireReport.slice(0, 16 + payloadLength));
    },
    close() {},
  };
  device = {
    gatt: {
      connected: true,
      connect: async () => ({
        getPrimaryService: async () => ({
          getCharacteristic: async (uuid) => uuid === REMOTE_COPY_BLE_WRITE ? this.write : this.notify,
        }),
      }),
      disconnect() {},
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

test("Client text completes only after the BLE/HID agent processing round trip", async () => {
  const esp = new SimulatedEspRelay();
  const processed = [];
  const agent = new RelayAgent(esp.hid, async (text) => {
    await new Promise((resolve) => setImmediate(resolve));
    processed.push(text);
  }, (error) => { throw error; });
  const transport = new WebBluetoothTransport(async () => esp.device);
  const client = new Client({ transport, requestTimeoutMs: 1_000 });

  await transport.connect();
  const text = "网页 -> 蓝牙 -> ESP32-S3 -> HID -> agent 🙂".repeat(20);
  const result = await client.sendText(text);

  assert.deepEqual(processed, [text]);
  assert.deepEqual(result, { pasted: true });
  await client.close();
  agent.close();
});
