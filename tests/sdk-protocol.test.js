const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("web/ai-input-sdk.js", "utf8");
const context = {
  window: {},
  navigator: {},
  TextEncoder,
  DataView,
  ArrayBuffer,
  Uint8Array,
  console,
};
vm.createContext(context);
vm.runInContext(source, context);

const internals = context.window.AIInput._internals;

{
  const { constants } = internals;
  assert.equal(constants.VERSION, 1);
  assert.equal(constants.DATA_FRAME, 16);
  assert.equal(constants.DATA_PAYLOAD_BYTES, 12);
}

{
  const frame = internals.encodeControlFrame(1, 7, 16, 2);
  assert.equal(frame.byteLength, 12);
  assert.deepEqual(Array.from(frame), [1, 1, 7, 0, 16, 0, 0, 0, 2, 0, 0, 0]);
}

{
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const chunks = internals.createDataFrames(9, bytes);
  assert.equal(chunks.length, 1);
  assert.deepEqual(Array.from(chunks[0]), [1, 16, 9, 0, 0, 0, 1, 0, 1, 2, 3, 4, 5]);
}

{
  const bytes = new Uint8Array(25);
  const chunks = internals.createDataFrames(3, bytes);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].byteLength, 20);
  assert.equal(chunks[1].byteLength, 20);
  assert.equal(chunks[2].byteLength, 9);
}

{
  const frame = new Uint8Array([1, 2, 12, 0, 0, 0, 0, 4, 0, 0, 0, 16, 0, 0]);
  const status = internals.decodeStatusFrame(frame.buffer);
  assert.deepEqual(status, {
    state: "typing",
    lastTaskId: 12,
    lastErrorCode: 0,
    receivedBytes: 1024,
    totalBytes: 4096,
  });
}

{
  const oversized = new Uint8Array((16 * 1024) + 1);
  assert.throws(
    () => internals.assertTextSize(oversized),
    /TEXT_TOO_LARGE/
  );
}

{
  const valid = new Uint8Array(16 * 1024);
  assert.equal(internals.assertTextSize(valid), undefined);
}

function createStatusFrame(stateCode, taskId, errorCode = 0, receivedBytes = 0, totalBytes = 0) {
  const frame = new ArrayBuffer(14);
  const view = new DataView(frame);
  view.setUint8(0, internals.constants.VERSION);
  view.setUint8(1, stateCode);
  view.setUint16(2, taskId, true);
  view.setUint16(4, errorCode, true);
  view.setUint32(6, receivedBytes, true);
  view.setUint32(10, totalBytes, true);
  return new DataView(frame);
}

class FakeCharacteristic {
  constructor() {
    this.writes = [];
    this.listeners = new Map();
    this.notificationsStarted = false;
    this.notificationsStopped = false;
    this.readValueResult = createStatusFrame(0, 0);
    this.writeError = null;
    this.writeNeverResolves = false;
    this.startNotificationsError = null;
  }

  async writeValueWithResponse(value) {
    if (this.writeError) throw this.writeError;
    this.writes.push(Array.from(value));
    if (this.writeNeverResolves) {
      return new Promise(() => {});
    }
  }

  async startNotifications() {
    if (this.startNotificationsError) throw this.startNotificationsError;
    this.notificationsStarted = true;
    return this;
  }

  async stopNotifications() {
    this.notificationsStopped = true;
    return this;
  }

  async readValue() {
    return this.readValueResult;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) {
      this.listeners.delete(type);
    }
  }

  emitStatus(value) {
    const listener = this.listeners.get("characteristicvaluechanged");
    if (listener) {
      listener({ target: { value } });
    }
  }
}

class FakeDevice {
  constructor(server) {
    this.listeners = new Map();
    this.gatt = {
      connected: false,
      connect: async () => {
        this.gatt.connected = true;
        return server;
      },
      disconnect: () => {
        this.disconnectCalls += 1;
        this.gatt.connected = false;
      },
    };
    this.disconnectCalls = 0;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) {
      this.listeners.delete(type);
    }
  }

  emitDisconnected() {
    const listener = this.listeners.get("gattserverdisconnected");
    if (listener) listener();
  }
}

function createFakeBluetooth() {
  const { CONTROL_UUID, DATA_UUID, SERVICE_UUID, STATUS_UUID } = internals.constants;
  const controlChar = new FakeCharacteristic();
  const dataChar = new FakeCharacteristic();
  const statusChar = new FakeCharacteristic();
  const characteristics = new Map([
    [CONTROL_UUID, controlChar],
    [DATA_UUID, dataChar],
    [STATUS_UUID, statusChar],
  ]);
  let requestedOptions = null;
  const service = {
    getCharacteristic: async (uuid) => characteristics.get(uuid),
  };
  const server = {
    getPrimaryService: async (uuid) => {
      assert.equal(uuid, SERVICE_UUID);
      return service;
    },
  };
  const device = new FakeDevice(server);
  context.navigator.bluetooth = {
    requestDevice: async (options) => {
      requestedOptions = options;
      return device;
    },
  };
  return {
    controlChar,
    dataChar,
    device,
    get requestedOptions() {
      return requestedOptions;
    },
    statusChar,
  };
}

async function assertRejectsWithCode(value, code) {
  let promise;
  if (typeof value === "function") {
    try {
      promise = Promise.resolve(value());
    } catch (error) {
      assert.equal(error.code, code);
      return;
    }
  } else {
    promise = value;
  }
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error.code, code);
      return true;
    }
  );
}

async function flushMicrotasks(count = 8) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function timeoutAfter(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(label)), ms);
  });
}

async function assertRejectsWithCodeBeforeTimeout(promise, code) {
  await assertRejectsWithCode(
    Promise.race([promise, timeoutAfter(50, `Timed out waiting for ${code}`)]),
    code
  );
}

async function runSdkFlowTests() {
  const { AIInput } = context.window;

  {
    delete context.navigator.bluetooth;
    await assertRejectsWithCode(AIInput.connect(), "WEB_BLUETOOTH_UNSUPPORTED");
  }

  {
    context.navigator.bluetooth = {
      requestDevice: async () => {
        const error = new Error("cancelled");
        error.name = "NotFoundError";
        throw error;
      },
    };
    await assertRejectsWithCode(AIInput.connect(), "DEVICE_SELECTION_CANCELLED");
  }

  {
    context.navigator.bluetooth = {
      requestDevice: async () => {
        const error = new Error("blocked");
        error.name = "SecurityError";
        throw error;
      },
    };
    await assertRejectsWithCode(AIInput.connect(), "DEVICE_REQUEST_FAILED");
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    assert.equal(fake.requestedOptions.filters.length, 1);
    assert.equal(fake.requestedOptions.filters[0].services.length, 1);
    assert.equal(fake.requestedOptions.filters[0].services[0], internals.constants.SERVICE_UUID);
    assert.equal(fake.requestedOptions.optionalServices.length, 1);
    assert.equal(fake.requestedOptions.optionalServices[0], internals.constants.SERVICE_UUID);
    assert.equal(fake.device.gatt.connected, true);
    assert.equal(fake.statusChar.notificationsStarted, true);
    assert.equal(typeof aiDevice.typeText, "function");
    assert.equal(typeof aiDevice.getStatus, "function");
    assert.equal(typeof aiDevice.disconnect, "function");
  }

  {
    const fake = createFakeBluetooth();
    fake.statusChar.startNotificationsError = new Error("notify failed");
    await assert.rejects(AIInput.connect());
    assert.equal(fake.device.disconnectCalls, 1);
    assert.equal(fake.device.gatt.connected, false);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    const completion = aiDevice.typeText("hello");
    await flushMicrotasks();

    assert.deepEqual(fake.controlChar.writes[0], [1, 1, 1, 0, 5, 0, 0, 0, 1, 0, 0, 0]);
    assert.deepEqual(fake.dataChar.writes[0], [1, 16, 1, 0, 0, 0, 1, 0, 104, 101, 108, 108, 111]);
    assert.deepEqual(fake.controlChar.writes[1], [1, 2, 1, 0, 5, 0, 0, 0, 1, 0, 0, 0]);

    fake.statusChar.emitStatus(createStatusFrame(3, 1, 0, 5, 5));
    const status = await completion;
    assert.equal(status.state, "done");
    assert.equal(status.lastTaskId, 1);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    fake.controlChar.writeNeverResolves = true;
    const completion = aiDevice.typeText("hung");
    await flushMicrotasks();
    fake.device.emitDisconnected();
    await assertRejectsWithCodeBeforeTimeout(completion, "DISCONNECTED");
    assert.equal(aiDevice.pending, null);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    fake.controlChar.writeNeverResolves = true;
    const completion = aiDevice.typeText("hung error");
    await flushMicrotasks();
    fake.statusChar.emitStatus(createStatusFrame(4, 1, 77, 0, 10));
    await assertRejectsWithCodeBeforeTimeout(completion, "DEVICE_ERROR_77");
    assert.equal(aiDevice.pending, null);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    const first = aiDevice.typeText("busy");
    await assertRejectsWithCode(() => aiDevice.typeText("again"), "CLIENT_BUSY");
    fake.statusChar.emitStatus(createStatusFrame(3, 1, 0, 4, 4));
    await first;
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    fake.statusChar.readValueResult = createStatusFrame(2, 7, 0, 3, 9);
    const status = await aiDevice.getStatus();
    assert.deepEqual(status, {
      state: "typing",
      lastTaskId: 7,
      lastErrorCode: 0,
      receivedBytes: 3,
      totalBytes: 9,
    });
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    const completion = aiDevice.typeText("fail");
    await flushMicrotasks();
    fake.statusChar.emitStatus(createStatusFrame(4, 1, 42, 4, 4));
    await assertRejectsWithCode(completion, "DEVICE_ERROR_42");
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    const completion = aiDevice.typeText("bad status");
    await flushMicrotasks();
    fake.statusChar.emitStatus(new DataView(new ArrayBuffer(2)));
    await assertRejectsWithCode(completion, "INVALID_STATUS_FRAME");
    assert.equal(aiDevice.pending, null);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    fake.dataChar.writeError = new Error("write failed");
    await assertRejectsWithCode(aiDevice.typeText("fail"), "BLE_WRITE_FAILED");
    assert.equal(aiDevice.pending, null);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    const completion = aiDevice.typeText("disconnect");
    const rejection = assertRejectsWithCode(completion, "DISCONNECTED");
    await flushMicrotasks();
    await aiDevice.disconnect();
    await rejection;
    assert.equal(aiDevice.connected, false);
    assert.equal(fake.statusChar.notificationsStopped, true);
    assert.equal(fake.device.gatt.connected, false);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    const completion = aiDevice.typeText("link lost");
    const rejection = assertRejectsWithCode(completion, "DISCONNECTED");
    fake.device.emitDisconnected();
    await rejection;
    assert.equal(aiDevice.connected, false);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await AIInput.connect();
    aiDevice.taskId = 65535;
    const completion = aiDevice.typeText("wrap");
    await flushMicrotasks();
    assert.deepEqual(fake.controlChar.writes[0].slice(0, 4), [1, 1, 255, 255]);
    fake.statusChar.emitStatus(createStatusFrame(3, 65535, 0, 4, 4));
    await completion;
    assert.equal(aiDevice.taskId, 1);
  }
}

runSdkFlowTests()
  .then(() => {
    console.log("sdk protocol tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
