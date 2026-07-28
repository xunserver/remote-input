import assert from "node:assert/strict";
import test from "node:test";
import {
  HID_REPORT_BYTES,
} from "@remote-input/device-protocol";
import {
  REMOTE_INPUT_BLE_WRITE,
  WebBluetoothTransport,
} from "@remote-input/protocol";
import { Client } from "@remote-input/sdk";
import { RelayAgent } from "@remote-input/web-agent-sdk";

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
      const report = new Uint8Array(HID_REPORT_BYTES);
      report.set(new Uint8Array(value));
      this.hidDataListener(report);
    },
  };
  hid = {
    onData: (listener) => { this.hidDataListener = listener; return () => { this.hidDataListener = () => {}; }; },
    write: () => { throw new Error("HID downlink is disabled"); },
    close() {},
  };
  device = {
    gatt: {
      connected: true,
      connect: async () => ({
        getPrimaryService: async () => ({
          getCharacteristic: async (uuid) => uuid === REMOTE_INPUT_BLE_WRITE ? this.write : this.notify,
        }),
      }),
      disconnect() {},
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

test("BLE/vendor-HID uplink can complete at the GATT write boundary without a downlink acknowledgement", async () => {
  const esp = new SimulatedEspRelay();
  const processed = [];
  const agent = new RelayAgent(esp.hid, async (command) => {
    await new Promise((resolve) => setImmediate(resolve));
    processed.push(command.text);
  }, (error) => { throw error; });
  const transport = new WebBluetoothTransport(async () => esp.device);
  const client = new Client({ transport, requestTimeoutMs: 50 });

  await transport.connect();
  const text = "网页 -> 蓝牙 -> ESP32-S3 -> HID -> agent 🙂".repeat(20);
  await client.sendTextUnconfirmed(text);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processed, [text]);
  await client.close();
  agent.close();
});
