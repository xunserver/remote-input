const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const packageJson = fs.readFileSync("package.json", "utf8");
assert.match(packageJson, /"build:sdk":\s*"vite build && vite build --config vite\.decoder\.config\.ts"/);

const viteConfig = fs.readFileSync("vite.config.ts", "utf8");
assert.match(viteConfig, /defineConfig/);
assert.match(viteConfig, /entry:\s*resolve\(__dirname,\s*"src\/index\.ts"\)/);
assert.match(viteConfig, /name:\s*"RemoteInput"/);
assert.match(viteConfig, /formats:\s*\["iife"\]/);
assert.match(viteConfig, /outDir:\s*"dist"/);
assert.match(viteConfig, /fileName:\s*\(\)\s*=>\s*"remote-input-sdk\.js"/);
assert.doesNotMatch(viteConfig, /emptyOutDir:\s*false/);

const decoderViteConfig = fs.readFileSync("vite.decoder.config.ts", "utf8");
assert.match(decoderViteConfig, /defineConfig/);
assert.match(decoderViteConfig, /entry:\s*resolve\(__dirname,\s*"src\/decoderBundle\.ts"\)/);
assert.match(decoderViteConfig, /name:\s*"RemoteInputDecoder"/);
assert.match(decoderViteConfig, /formats:\s*\["iife"\]/);
assert.match(decoderViteConfig, /fileName:\s*\(\)\s*=>\s*"remote-input-decoder\.js"/);
assert.match(decoderViteConfig, /outDir:\s*"dist"/);
assert.match(decoderViteConfig, /emptyOutDir:\s*false/);

const demoHtml = fs.readFileSync("index.html", "utf8");
assert.match(demoHtml, /<script type="module">/);
assert.match(demoHtml, /import \* as RemoteInput from "\.\/src\/index\.ts";/);
assert.doesNotMatch(demoHtml, /EnableHexNumpad/);
assert.match(demoHtml, /decode\.html/);
assert.match(demoHtml, /Vite dev server/i);
assert.match(demoHtml, /US\/English/i);
assert.match(demoHtml, /输入法组合状态|输入法/i);

const decodeHtml = fs.readFileSync("decode.html", "utf8");
assert.match(decodeHtml, /<title>Remote Input Decoder<\/title>/);
assert.match(
  decodeHtml,
  /import \{\s*createRib32DecoderState,\s*getRib32LineErrors,\s*getRib32Tasks,\s*ingestRib32Text\s*\} from "\.\/src\/base32Frame\.ts";/
);
assert.match(decodeHtml, /id="rib32Input"/);
assert.match(decodeHtml, /id="taskList"/);
assert.match(decodeHtml, /id="lineErrorList"/);
assert.match(decodeHtml, /let processedLength = 0;/);
assert.match(decodeHtml, /slice\(processedLength\)/);
assert.match(decodeHtml, /processedLength = 0;/);
assert.match(decodeHtml, /Vite dev server/i);
assert.match(decodeHtml, /US\/English/i);
assert.match(decodeHtml, /输入法组合状态|输入法/i);

const protocolDoc = fs.readFileSync("../docs/remote-input-protocol.md", "utf8");
assert.match(protocolDoc, /Vite dev server|Vite 页面/);
assert.match(protocolDoc, /US\/English/i);
assert.match(protocolDoc, /输入法组合状态|输入法/i);
assert.match(protocolDoc, /人工验证|手工验证/);

const source = fs.readFileSync("dist/remote-input-sdk.js", "utf8");
const context = {
  window: {},
  navigator: {},
  TextEncoder,
  DataView,
  ArrayBuffer,
  Uint8Array,
  setTimeout,
  clearTimeout,
  console,
};
vm.createContext(context);
vm.runInContext(source, context);

const remoteInputGlobal = context.window.RemoteInput || context.RemoteInput;
const internals = remoteInputGlobal._internals;

assert.equal(typeof remoteInputGlobal.connect, "function");
assert.equal(remoteInputGlobal.connectBle, remoteInputGlobal.connect);
assert.equal(typeof remoteInputGlobal.RemoteInputClient, "function");
assert.equal(remoteInputGlobal.RemoteInputDevice, remoteInputGlobal.RemoteInputClient);
assert.equal(typeof remoteInputGlobal.connectWs, "function");
assert.equal(remoteInputGlobal.RemoteInput.connectWs, remoteInputGlobal.connectWs);
assert.equal(typeof remoteInputGlobal.base32Encode, "function");
assert.equal(typeof remoteInputGlobal.base32Decode, "function");
assert.equal(typeof remoteInputGlobal.crc32, "function");
assert.equal(typeof remoteInputGlobal.formatRib32Frames, "function");
assert.equal(typeof remoteInputGlobal.createRib32DecoderState, "function");
assert.equal(typeof remoteInputGlobal.ingestRib32Text, "function");
assert.equal(typeof remoteInputGlobal.getRib32Tasks, "function");
assert.equal(typeof remoteInputGlobal.getRib32LineErrors, "function");
assert.equal(typeof remoteInputGlobal.RemoteInputDecoder, "function");
assert.equal(typeof remoteInputGlobal.createRib32InputDecoder, "function");
assert.equal(remoteInputGlobal.RemoteInput.RemoteInputDecoder, remoteInputGlobal.RemoteInputDecoder);
assert.equal(remoteInputGlobal.RemoteInput.createRib32InputDecoder, remoteInputGlobal.createRib32InputDecoder);
assert.equal(remoteInputGlobal.RIB32_VERSION, 1);
assert.equal(remoteInputGlobal.RIB32_CHUNK_BYTES, 32);

const decoderSource = fs.readFileSync("dist/remote-input-decoder.js", "utf8");
const decoderContext = {
  window: {},
  TextDecoder,
  Uint8Array,
};
vm.createContext(decoderContext);
vm.runInContext(decoderSource, decoderContext);

const decoderGlobal = decoderContext.window.RemoteInputDecoder || decoderContext.RemoteInputDecoder;
assert.equal(typeof decoderGlobal.RemoteInputDecoder, "function");
assert.equal(typeof decoderGlobal.createRib32InputDecoder, "function");
assert.equal(typeof decoderGlobal.formatRib32Frames, "function");
assert.equal(typeof decoderGlobal.ingestRib32Text, "function");
assert.equal(decoderGlobal.RIB32_VERSION, 1);
assert.equal(decoderGlobal.RIB32_CHUNK_BYTES, 32);

{
  const { constants } = internals;
  assert.equal(constants.VERSION, 2);
  assert.equal(constants.DATA_FRAME, 16);
  assert.equal(constants.DATA_PAYLOAD_BYTES, 180);
  assert.equal(constants.MAX_TEXT_BYTES, 128 * 1024);
}

{
  const { constants } = internals;
  assert.equal(constants.CONTROL_CONFIG, 3);
  assert.equal(constants.DEFAULT_KEY_DELAY_MS, 20);
  assert.equal(constants.MIN_KEY_DELAY_MS, 1);
  assert.equal(constants.MAX_KEY_DELAY_MS, 200);
}

{
  const frame = internals.encodeControlFrame(1, 7, 16, 2);
  assert.equal(frame.byteLength, 12);
  assert.deepEqual(Array.from(frame), [2, 1, 7, 0, 16, 0, 0, 0, 2, 0, 0, 0]);
}

{
  const frame = internals.encodeConfigFrame({ keyDelayMs: 10 });
  assert.equal(frame.byteLength, 12);
  assert.deepEqual(Array.from(frame), [2, 3, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
}

{
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const chunks = internals.createDataFrames(9, bytes);
  assert.equal(chunks.length, 1);
  assert.deepEqual(Array.from(chunks[0]), [2, 16, 9, 0, 0, 0, 1, 0, 1, 2, 3, 4, 5]);
}

{
  const bytes = new Uint8Array(361);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index & 0xff;
  }
  const chunks = internals.createDataFrames(3, bytes);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].byteLength, 188);
  assert.equal(chunks[1].byteLength, 188);
  assert.equal(chunks[2].byteLength, 9);
  assert.deepEqual(Array.from(chunks[0].slice(0, 8)), [2, 16, 3, 0, 0, 0, 3, 0]);
  assert.deepEqual(Array.from(chunks[1].slice(0, 8)), [2, 16, 3, 0, 1, 0, 3, 0]);
  assert.deepEqual(Array.from(chunks[2]), [2, 16, 3, 0, 2, 0, 3, 0, 104]);
}

{
  const frame = new Uint8Array([2, 2, 12, 0, 0, 0, 0, 4, 0, 0, 0, 16, 0, 0]);
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
  const frame = new Uint8Array([1, 2, 12, 0, 0, 0, 0, 4, 0, 0, 0, 16, 0, 0]);
  assert.throws(
    () => internals.decodeStatusFrame(frame.buffer),
    /INVALID_STATUS_FRAME/
  );
}

{
  assert.throws(
    () => internals.decodeStatusFrame(createStatusFrame(99, 1)),
    /INVALID_STATUS_FRAME/
  );
}

{
  const oversized = new Uint8Array((128 * 1024) + 1);
  assert.throws(
    () => internals.assertTextSize(oversized),
    /TEXT_TOO_LARGE/
  );
}

{
  const valid = new Uint8Array(128 * 1024);
  assert.equal(internals.assertTextSize(valid), undefined);
}

{
  assert.equal(internals.assertConfig({ keyDelayMs: 1 }), undefined);
  assert.equal(internals.assertConfig({ keyDelayMs: 200 }), undefined);
  assert.throws(() => internals.assertConfig({ keyDelayMs: 0 }), /INVALID_CONFIG/);
  assert.throws(() => internals.assertConfig({ keyDelayMs: 201 }), /INVALID_CONFIG/);
  assert.throws(() => internals.assertConfig({ keyDelayMs: 1.5 }), /INVALID_CONFIG/);
  assert.throws(() => internals.assertConfig({ keyDelayMs: Number.NaN }), /INVALID_CONFIG/);
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
    this.writeWithoutResponseCalls = [];
    this.listeners = new Map();
    this.notificationsStarted = false;
    this.notificationsStopped = false;
    this.readValueResult = createStatusFrame(0, 0);
    this.afterWrite = null;
    this.writeError = null;
    this.writeWithoutResponseError = null;
    this.supportsWriteWithoutResponse = false;
    this.writeNeverResolves = false;
    this.startNotificationsError = null;
    this.writeValueWithoutResponse = undefined;
  }

  async writeValueWithResponse(value) {
    if (this.writeError) throw this.writeError;
    this.writes.push(Array.from(value));
    if (this.afterWrite) await this.afterWrite(value, this.writes.length);
    if (this.writeNeverResolves) {
      return new Promise(() => {});
    }
  }

  async performWriteValueWithoutResponse(value) {
    if (!this.supportsWriteWithoutResponse) {
      throw new Error("write without response not supported");
    }
    if (this.writeWithoutResponseError) throw this.writeWithoutResponseError;
    this.writeWithoutResponseCalls.push(Array.from(value));
    if (this.afterWrite) await this.afterWrite(value, this.writes.length + this.writeWithoutResponseCalls.length);
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
        this.connectCalls += 1;
        this.gatt.connected = true;
        return server;
      },
      disconnect: () => {
        this.disconnectCalls += 1;
        this.gatt.connected = false;
      },
    };
    this.connectCalls = 0;
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
      if (!device.gatt.connected) {
        throw new Error("GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.");
      }
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

class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static throwOnConstruct = null;

  constructor(url) {
    if (FakeWebSocket.throwOnConstruct) {
      throw FakeWebSocket.throwOnConstruct;
    }
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.binaryType = "";
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(value) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket is not open");
    }
    this.sent.push(value instanceof Uint8Array ? Array.from(value) : value);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  openWithInitialStatus(status = createStatusFrame(0, 0)) {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
    this.emitMessage(status);
  }

  emitMessage(data) {
    this.emit("message", { data });
  }

  emitError(error = new Error("ws failed")) {
    this.emit("error", error);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
}

async function connectFakeWs(RemoteInput, url) {
  FakeWebSocket.instances = [];
  FakeWebSocket.throwOnConstruct = null;
  context.WebSocket = FakeWebSocket;
  const promise = url === undefined ? RemoteInput.connectWs() : RemoteInput.connectWs(url);
  await flushMicrotasks();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  socket.openWithInitialStatus();
  const device = await promise;
  return { device, socket };
}

async function connectFakeWsWithOptions(RemoteInput, url, options) {
  FakeWebSocket.instances = [];
  FakeWebSocket.throwOnConstruct = null;
  context.WebSocket = FakeWebSocket;
  const promise = RemoteInput.connectWs(url, options);
  await flushMicrotasks();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  socket.openWithInitialStatus();
  const device = await promise;
  return { device, socket };
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
  const RemoteInput = remoteInputGlobal;

  {
    delete context.navigator.bluetooth;
    await assertRejectsWithCode(RemoteInput.connect(), "WEB_BLUETOOTH_UNSUPPORTED");
  }

  {
    delete context.WebSocket;
    await assertRejectsWithCode(RemoteInput.connectWs(), "WEB_SOCKET_UNSUPPORTED");
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    assert.equal(socket.url, "ws://192.168.4.1/ws");
    assert.equal(socket.binaryType, "arraybuffer");
    assert.equal(device.connected, true);
    const status = await device.getStatus();
    assert.equal(status.state, "idle");
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    assert.deepEqual(device.getConfig(), { keyDelayMs: 20 });
    await device.setConfig({ keyDelayMs: 10 });
    assert.deepEqual(socket.sent[0], [2, 3, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(device.getConfig(), { keyDelayMs: 10 });
  }

  {
    const { device } = await connectFakeWs(RemoteInput);
    await assertRejectsWithCode(() => device.setConfig({ keyDelayMs: 0 }), "INVALID_CONFIG");
    assert.deepEqual(device.getConfig(), { keyDelayMs: 20 });
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    socket.readyState = FakeWebSocket.CLOSED;
    await assertRejectsWithCode(() => device.setConfig({ keyDelayMs: 10 }), "NOT_CONNECTED");
    assert.deepEqual(device.getConfig(), { keyDelayMs: 20 });
  }

  {
    const { socket } = await connectFakeWs(RemoteInput, "ws://192.168.4.1/ws");
    assert.equal(socket.url, "ws://192.168.4.1/ws");
  }

  {
    const { device, socket } = await connectFakeWsWithOptions(
      RemoteInput,
      "ws://192.168.4.1/ws",
      { config: { keyDelayMs: 15 } }
    );
    assert.deepEqual(socket.sent[0], [2, 3, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(device.getConfig(), { keyDelayMs: 15 });
  }

  {
    await assertRejectsWithCode(
      () => connectFakeWsWithOptions(RemoteInput, "ws://192.168.4.1/ws", { config: { keyDelayMs: 201 } }),
      "INVALID_CONFIG"
    );
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    const completion = device.typeText("ws");
    await flushMicrotasks();
    assert.deepEqual(socket.sent[0], [2, 1, 1, 0, 2, 0, 0, 0, 1, 0, 0, 0]);
    assert.deepEqual(socket.sent[1], [2, 16, 1, 0, 0, 0, 1, 0, 119, 115]);
    assert.deepEqual(socket.sent[2], [2, 2, 1, 0, 2, 0, 0, 0, 1, 0, 0, 0]);
    socket.emitMessage(createStatusFrame(3, 1, 0, 2, 2));
    const status = await completion;
    assert.equal(status.state, "done");
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    const completion = device.typeText("close");
    await flushMicrotasks();
    socket.close();
    await assertRejectsWithCodeBeforeTimeout(completion, "DISCONNECTED");
    assert.equal(device.connected, false);
  }

  {
    const { device, socket } = await connectFakeWs(RemoteInput);
    const completion = device.typeText("bad");
    await flushMicrotasks();
    socket.emitMessage(new ArrayBuffer(2));
    await assertRejectsWithCode(completion, "INVALID_STATUS_FRAME");
    assert.equal(device.pending, null);
  }

  {
    FakeWebSocket.instances = [];
    FakeWebSocket.throwOnConstruct = null;
    context.WebSocket = FakeWebSocket;
    const promise = RemoteInput.connectWs();
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open", {});
    socket.emitMessage(new ArrayBuffer(2));
    await assertRejectsWithCode(promise, "INVALID_STATUS_FRAME");
  }

  {
    FakeWebSocket.instances = [];
    FakeWebSocket.throwOnConstruct = null;
    context.WebSocket = FakeWebSocket;
    const promise = RemoteInput.connectWs();
    await flushMicrotasks();
    FakeWebSocket.instances[0].emitError(new Error("cannot connect"));
    await assertRejectsWithCode(promise, "WEB_SOCKET_CONNECT_FAILED");
  }

  {
    FakeWebSocket.instances = [];
    FakeWebSocket.throwOnConstruct = new SyntaxError("invalid url");
    context.WebSocket = FakeWebSocket;
    await assertRejectsWithCode(() => RemoteInput.connectWs("not a ws url"), "WEB_SOCKET_CONNECT_FAILED");
    FakeWebSocket.throwOnConstruct = null;
  }

  {
    FakeWebSocket.instances = [];
    FakeWebSocket.throwOnConstruct = null;
    context.WebSocket = FakeWebSocket;
    const promise = RemoteInput.connectWs("ws://192.168.4.1/ws", { initialStatusTimeoutMs: 1 });
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open", {});
    await assertRejectsWithCode(promise, "WEB_SOCKET_CONNECT_FAILED");
  }

  {
    context.navigator.bluetooth = {
      requestDevice: async () => {
        const error = new Error("cancelled");
        error.name = "NotFoundError";
        throw error;
      },
    };
    await assertRejectsWithCode(RemoteInput.connect(), "DEVICE_SELECTION_CANCELLED");
  }

  {
    context.navigator.bluetooth = {
      requestDevice: async () => {
        const error = new Error("blocked");
        error.name = "SecurityError";
        throw error;
      },
    };
    await assertRejectsWithCode(RemoteInput.connect(), "DEVICE_REQUEST_FAILED");
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
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
    const originalConnect = fake.device.gatt.connect;
    let serviceAttempts = 0;
    fake.device.gatt.connect = async () => {
      const server = await originalConnect();
      return {
        getPrimaryService: async (uuid) => {
          serviceAttempts += 1;
          if (serviceAttempts === 1) {
            fake.device.gatt.connected = false;
            throw new Error("GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.");
          }
          return server.getPrimaryService(uuid);
        },
      };
    };

    const aiDevice = await RemoteInput.connect();
    assert.equal(fake.device.connectCalls, 2);
    assert.equal(serviceAttempts, 2);
    assert.equal(fake.device.gatt.connected, true);
    assert.equal(fake.statusChar.notificationsStarted, true);
    assert.equal(typeof aiDevice.typeText, "function");
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect({ config: { keyDelayMs: 12 } });
    assert.deepEqual(fake.controlChar.writes[0], [2, 3, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(aiDevice.getConfig(), { keyDelayMs: 12 });
  }

  {
    const fake = createFakeBluetooth();
    fake.statusChar.startNotificationsError = new Error("notify failed");
    await assertRejectsWithCode(RemoteInput.connect(), "BLE_CONNECT_FAILED");
    assert.equal(fake.device.disconnectCalls, 1);
    assert.equal(fake.device.gatt.connected, false);
  }

  {
    const fake = createFakeBluetooth();
    fake.device.gatt.connect = async () => {
      fake.device.gatt.connected = true;
      fake.device.gatt.connected = false;
      return {
        getPrimaryService: async () => {
          throw new Error("GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.");
        },
      };
    };
    await assertRejectsWithCode(RemoteInput.connect(), "BLE_CONNECT_FAILED");
    assert.equal(fake.device.disconnectCalls, 0);
    assert.equal(fake.device.gatt.connected, false);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
    const completion = aiDevice.typeText("hello");
    await flushMicrotasks();

    assert.deepEqual(fake.controlChar.writes[0], [2, 1, 1, 0, 5, 0, 0, 0, 1, 0, 0, 0]);
    assert.deepEqual(fake.dataChar.writes[0], [2, 16, 1, 0, 0, 0, 1, 0, 104, 101, 108, 108, 111]);
    assert.deepEqual(fake.controlChar.writes[1], [2, 2, 1, 0, 5, 0, 0, 0, 1, 0, 0, 0]);

    fake.statusChar.emitStatus(createStatusFrame(3, 1, 0, 5, 5));
    const status = await completion;
    assert.equal(status.state, "done");
    assert.equal(status.lastTaskId, 1);
  }

  {
    const fake = createFakeBluetooth();
    fake.dataChar.supportsWriteWithoutResponse = true;
    fake.dataChar.writeValueWithoutResponse = fake.dataChar.performWriteValueWithoutResponse.bind(fake.dataChar);
    const aiDevice = await RemoteInput.connect();
    const completion = aiDevice.typeText("fast");
    await flushMicrotasks();

    assert.deepEqual(fake.controlChar.writes[0], [2, 1, 1, 0, 4, 0, 0, 0, 1, 0, 0, 0]);
    assert.deepEqual(fake.dataChar.writeWithoutResponseCalls[0], [2, 16, 1, 0, 0, 0, 1, 0, 102, 97, 115, 116]);
    assert.equal(fake.dataChar.writes.length, 0);
    assert.deepEqual(fake.controlChar.writes[1], [2, 2, 1, 0, 4, 0, 0, 0, 1, 0, 0, 0]);

    fake.statusChar.emitStatus(createStatusFrame(3, 1, 0, 4, 4));
    await completion;
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
    fake.controlChar.writeError = new Error("config write failed");
    await assertRejectsWithCode(() => aiDevice.setConfig({ keyDelayMs: 11 }), "BLE_WRITE_FAILED");
    assert.deepEqual(aiDevice.getConfig(), { keyDelayMs: 20 });
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
    fake.controlChar.writeNeverResolves = true;
    const completion = aiDevice.typeText("hung");
    await flushMicrotasks();
    fake.device.emitDisconnected();
    await assertRejectsWithCodeBeforeTimeout(completion, "DISCONNECTED");
    assert.equal(aiDevice.pending, null);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
    fake.controlChar.writeNeverResolves = true;
    const completion = aiDevice.typeText("hung error");
    await flushMicrotasks();
    fake.statusChar.emitStatus(createStatusFrame(4, 1, 77, 0, 10));
    await assertRejectsWithCodeBeforeTimeout(completion, "DEVICE_ERROR_77");
    assert.equal(aiDevice.pending, null);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
    const first = aiDevice.typeText("busy");
    await assertRejectsWithCode(() => aiDevice.typeText("again"), "CLIENT_BUSY");
    fake.statusChar.emitStatus(createStatusFrame(3, 1, 0, 4, 4));
    await first;
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
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
    const aiDevice = await RemoteInput.connect();
    const completion = aiDevice.typeText("fail");
    await flushMicrotasks();
    fake.statusChar.emitStatus(createStatusFrame(4, 1, 42, 4, 4));
    await assertRejectsWithCode(completion, "DEVICE_ERROR_42");
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
    fake.controlChar.afterWrite = (_value, writeCount) => {
      if (writeCount === 1) {
        fake.statusChar.emitStatus(createStatusFrame(4, 1, 1, 0, 4));
      }
    };
    const completion = aiDevice.typeText("stop");
    await assertRejectsWithCodeBeforeTimeout(completion, "DEVICE_ERROR_1");
    await flushMicrotasks();
    assert.equal(fake.controlChar.writes.length, 1);
    assert.equal(fake.dataChar.writes.length, 0);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
    const completion = aiDevice.typeText("bad status");
    await flushMicrotasks();
    fake.statusChar.emitStatus(new DataView(new ArrayBuffer(2)));
    await assertRejectsWithCode(completion, "INVALID_STATUS_FRAME");
    assert.equal(aiDevice.pending, null);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
    fake.dataChar.writeError = new Error("write failed");
    await assertRejectsWithCode(aiDevice.typeText("fail"), "BLE_WRITE_FAILED");
    assert.equal(aiDevice.pending, null);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
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
    const aiDevice = await RemoteInput.connect();
    const completion = aiDevice.typeText("link lost");
    const rejection = assertRejectsWithCode(completion, "DISCONNECTED");
    fake.device.emitDisconnected();
    await rejection;
    assert.equal(aiDevice.connected, false);
  }

  {
    const fake = createFakeBluetooth();
    const aiDevice = await RemoteInput.connect();
    aiDevice.taskId = 65535;
    const completion = aiDevice.typeText("wrap");
    await flushMicrotasks();
    assert.deepEqual(fake.controlChar.writes[0].slice(0, 4), [2, 1, 255, 255]);
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
