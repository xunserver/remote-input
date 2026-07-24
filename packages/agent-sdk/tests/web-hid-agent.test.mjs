import assert from "node:assert/strict";
import test from "node:test";
import {
  HID_PAYLOAD_BYTES,
  HID_REPORT_BYTES,
  RelayReassembler,
  decodeRelayFrame,
  encodeRelayFrame,
  splitRelayMessage,
} from "@remote-copy/device-protocol";
import {
  REMOTE_COPY_USB_PRODUCT_ID,
  REMOTE_COPY_USB_VENDOR_ID,
  WebHidAgent,
  getWebHidSupport,
} from "../dist/index.js";

class FakeDevice {
  opened = false;
  productId = REMOTE_COPY_USB_PRODUCT_ID;
  productName = "Remote Copy HID Relay";
  vendorId = REMOTE_COPY_USB_VENDOR_ID;
  listeners = new Set();
  writes = [];

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendReport(reportId, data) {
    assert.equal(reportId, 0);
    this.writes.push(ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
      : new Uint8Array(data).slice());
  }
  addEventListener(_type, listener) { this.listeners.add(listener); }
  removeEventListener(_type, listener) { this.listeners.delete(listener); }
  emit(report) {
    const data = new DataView(report.buffer, report.byteOffset, report.byteLength);
    for (const listener of this.listeners) {
      listener({ data, device: this, reportId: 0 });
    }
  }
}

class FakeHidNavigator {
  authorized = [];
  requested = [];
  listeners = { connect: new Set(), disconnect: new Set() };
  requestOptions;

  async getDevices() { return this.authorized; }
  async requestDevice(options) { this.requestOptions = options; return this.requested; }
  addEventListener(type, listener) { this.listeners[type].add(listener); }
  removeEventListener(type, listener) { this.listeners[type].delete(listener); }
  emit(type, device) {
    for (const listener of this.listeners[type]) listener({ device });
  }
}

function emitRequest(device, text, transferId = 17) {
  const request = new TextEncoder().encode(JSON.stringify({
    type: "request",
    requestId: 9,
    method: "sendText",
    payload: { text },
  }));
  for (const frame of splitRelayMessage(transferId, request, HID_PAYLOAD_BYTES)) {
    const report = new Uint8Array(HID_REPORT_BYTES);
    report.set(encodeRelayFrame(frame));
    device.emit(report);
  }
}

test("WebHidAgent receives UTF-8 text and writes the Session response", async () => {
  const device = new FakeDevice();
  const hid = new FakeHidNavigator();
  hid.requested = [device];
  const received = [];
  const states = [];
  const agent = new WebHidAgent({
    environment: { hid, isSecureContext: true },
    onText: async (text, context) => received.push({ text, context }),
    onStateChange: (state) => states.push(state),
  });

  await agent.connect();
  assert.equal(agent.state, "connected");
  assert.deepEqual(hid.requestOptions.filters, [{
    vendorId: REMOTE_COPY_USB_VENDOR_ID,
    productId: REMOTE_COPY_USB_PRODUCT_ID,
    usagePage: 0xff00,
    usage: 1,
  }]);

  emitRequest(device, "网页接收中文和 emoji 🙂".repeat(8));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{
    text: "网页接收中文和 emoji 🙂".repeat(8),
    context: { requestId: 9, transferId: 17 },
  }]);

  const reassembler = new RelayReassembler();
  let response;
  for (const report of device.writes) {
    response = reassembler.accept(decodeRelayFrame(report)) ?? response;
  }
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response)), {
    type: "response",
    requestId: 9,
    ok: true,
    data: { pasted: true },
  });
  assert.deepEqual(states, ["connecting", "connected"]);
  await agent.close();
  assert.equal(device.opened, false);
});

test("WebHidAgent restores authorized devices and reports physical disconnects", async () => {
  const device = new FakeDevice();
  const hid = new FakeHidNavigator();
  hid.authorized = [device];
  const states = [];
  const agent = new WebHidAgent({
    environment: { hid, isSecureContext: true },
    onText: () => undefined,
    onStateChange: (state) => states.push(state),
  });

  assert.equal(await agent.connectAuthorized(), true);
  hid.emit("disconnect", device);
  assert.equal(agent.state, "disconnected");
  hid.emit("connect", device);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agent.state, "connected");
  assert.ok(states.includes("disconnected"));
  await agent.close();
});

test("WebHID support distinguishes secure-context and browser failures", () => {
  assert.deepEqual(getWebHidSupport({ isSecureContext: false }), {
    supported: false,
    reason: "insecure_context",
  });
  assert.deepEqual(getWebHidSupport({ isSecureContext: true }), {
    supported: false,
    reason: "unsupported",
  });
});
