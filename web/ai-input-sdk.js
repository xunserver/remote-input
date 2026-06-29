(function attachAIInput(global) {
  "use strict";

  const SERVICE_UUID = "9e7b0001-4f2a-4d3b-9c2a-0d6c9a120001";
  const CONTROL_UUID = "9e7b0002-4f2a-4d3b-9c2a-0d6c9a120001";
  const DATA_UUID = "9e7b0003-4f2a-4d3b-9c2a-0d6c9a120001";
  const STATUS_UUID = "9e7b0004-4f2a-4d3b-9c2a-0d6c9a120001";

  const VERSION = 1;
  const CONTROL_START = 1;
  const CONTROL_COMMIT = 2;
  const DATA_FRAME = 16;
  const MAX_TEXT_BYTES = 16 * 1024;
  const DATA_PAYLOAD_BYTES = 12;

  const STATES = ["idle", "receiving", "typing", "done", "error"];

  class AIInputError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = "AIInputError";
      this.code = code;
      if (cause !== undefined) {
        this.cause = cause;
      }
    }

    toString() {
      return `${this.name} [${this.code}]: ${this.message}`;
    }
  }

  function encodeControlFrame(type, taskId, totalBytes, totalChunks) {
    const frame = new ArrayBuffer(12);
    const view = new DataView(frame);
    view.setUint8(0, VERSION);
    view.setUint8(1, type);
    view.setUint16(2, taskId, true);
    view.setUint32(4, totalBytes, true);
    view.setUint16(8, totalChunks, true);
    view.setUint16(10, 0, true);
    return new Uint8Array(frame);
  }

  function createDataFrames(taskId, bytes) {
    const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / DATA_PAYLOAD_BYTES));
    const frames = [];
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * DATA_PAYLOAD_BYTES;
      const payload = bytes.slice(start, start + DATA_PAYLOAD_BYTES);
      const frame = new Uint8Array(8 + payload.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint8(0, VERSION);
      view.setUint8(1, DATA_FRAME);
      view.setUint16(2, taskId, true);
      view.setUint16(4, chunkIndex, true);
      view.setUint16(6, totalChunks, true);
      frame.set(payload, 8);
      frames.push(frame);
    }
    return frames;
  }

  function createStatusObject() {
    if (global.constructor && global.constructor.name === "Object") {
      return new global.constructor();
    }
    return {};
  }

  function decodeStatusFrame(buffer) {
    const view = buffer instanceof DataView ? buffer : new DataView(buffer);
    if (view.byteLength !== 14 || view.getUint8(0) !== VERSION) {
      throw new AIInputError("INVALID_STATUS_FRAME", "Invalid status frame");
    }
    const stateCode = view.getUint8(1);
    const status = createStatusObject();
    status.state = STATES[stateCode] || "error";
    status.lastTaskId = view.getUint16(2, true);
    status.lastErrorCode = view.getUint16(4, true);
    status.receivedBytes = view.getUint32(6, true);
    status.totalBytes = view.getUint32(10, true);
    return status;
  }

  function assertTextSize(bytes) {
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      throw new AIInputError("TEXT_TOO_LARGE", "Text exceeds 16 KB UTF-8 limit");
    }
  }

  class AIInputDevice {
    constructor(device, server, controlChar, dataChar, statusChar) {
      this.device = device;
      this.server = server;
      this.controlChar = controlChar;
      this.dataChar = dataChar;
      this.statusChar = statusChar;
      this.taskId = 1;
      this.pending = null;
      this.connected = true;
      this._statusNotificationsStarted = false;
      this._onDisconnected = this._onDisconnected.bind(this);
      this._onStatusChanged = this._onStatusChanged.bind(this);
      this.device.addEventListener("gattserverdisconnected", this._onDisconnected);
    }

    async startNotifications() {
      await this.statusChar.startNotifications();
      this._statusNotificationsStarted = true;
      this.statusChar.addEventListener("characteristicvaluechanged", this._onStatusChanged);
    }

    typeText(text) {
      if (!this.connected) {
        return Promise.reject(new AIInputError("NOT_CONNECTED", "Device is not connected"));
      }
      if (this.pending) {
        return Promise.reject(new AIInputError("CLIENT_BUSY", "A typeText call is already pending"));
      }

      const bytes = new TextEncoder().encode(text);
      try {
        assertTextSize(bytes);
      } catch (error) {
        return Promise.reject(error);
      }

      const taskId = this.taskId;
      this.taskId = (this.taskId % 65535) + 1;

      const frames = createDataFrames(taskId, bytes);
      const startFrame = encodeControlFrame(CONTROL_START, taskId, bytes.byteLength, frames.length);
      const commitFrame = encodeControlFrame(CONTROL_COMMIT, taskId, bytes.byteLength, frames.length);

      const completion = new Promise((resolve, reject) => {
        this.pending = { taskId, resolve, reject };
      });

      this._pumpWrites(taskId, startFrame, frames, commitFrame);

      return completion;
    }

    async _pumpWrites(taskId, startFrame, frames, commitFrame) {
      try {
        await this.controlChar.writeValueWithResponse(startFrame);
        for (const frame of frames) {
          await this.dataChar.writeValueWithResponse(frame);
        }
        await this.controlChar.writeValueWithResponse(commitFrame);
      } catch (error) {
        if (this.pending && this.pending.taskId === taskId) {
          this._rejectPending("BLE_WRITE_FAILED", error.message || "BLE write failed", error);
        }
      }
    }

    async getStatus() {
      if (!this.connected) {
        throw new AIInputError("NOT_CONNECTED", "Device is not connected");
      }
      const value = await this.statusChar.readValue();
      return decodeStatusFrame(value);
    }

    async disconnect() {
      this.connected = false;
      this._rejectPending("DISCONNECTED", "Device disconnected");

      try {
        this.statusChar.removeEventListener("characteristicvaluechanged", this._onStatusChanged);
        if (this._statusNotificationsStarted && this.statusChar.stopNotifications) {
          await this.statusChar.stopNotifications();
          this._statusNotificationsStarted = false;
        }
      } catch (_) {
        // Ignore cleanup errors during disconnect.
      }

      this.device.removeEventListener("gattserverdisconnected", this._onDisconnected);
      if (this.device.gatt && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
    }

    _onStatusChanged(event) {
      let status;
      try {
        status = decodeStatusFrame(event.target.value);
      } catch (error) {
        if (this.pending) {
          this._rejectPending("INVALID_STATUS_FRAME", error.message, error);
        }
        return;
      }
      if (!this.pending || status.lastTaskId !== this.pending.taskId) {
        return;
      }
      if (status.state === "done") {
        const pending = this.pending;
        this.pending = null;
        pending.resolve(status);
        return;
      }
      if (status.state === "error") {
        this._rejectPending(`DEVICE_ERROR_${status.lastErrorCode}`, "Device returned an error");
      }
    }

    _onDisconnected() {
      this.connected = false;
      this._rejectPending("DISCONNECTED", "Device disconnected");
    }

    _rejectPending(code, message, cause) {
      if (!this.pending) {
        return;
      }
      const pending = this.pending;
      this.pending = null;
      pending.reject(new AIInputError(code, message, cause));
    }
  }

  const AIInput = {
    connect,
    AIInputError,
    AIInputDevice,
    _internals: {
      encodeControlFrame,
      createDataFrames,
      decodeStatusFrame,
      assertTextSize,
      constants: {
        VERSION,
        SERVICE_UUID,
        CONTROL_UUID,
        DATA_UUID,
        STATUS_UUID,
        CONTROL_START,
        CONTROL_COMMIT,
        DATA_FRAME,
        MAX_TEXT_BYTES,
        DATA_PAYLOAD_BYTES,
      },
    },
  };

  async function connect() {
    if (!navigator.bluetooth) {
      throw new AIInputError("WEB_BLUETOOTH_UNSUPPORTED", "Web Bluetooth is not available");
    }

    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });
    } catch (error) {
      if (error.name === "NotFoundError") {
        throw new AIInputError("DEVICE_SELECTION_CANCELLED", error.message || "Device selection cancelled", error);
      }
      throw new AIInputError("DEVICE_REQUEST_FAILED", error.message || "Device request failed", error);
    }

    let aiDevice = null;
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const controlChar = await service.getCharacteristic(CONTROL_UUID);
      const dataChar = await service.getCharacteristic(DATA_UUID);
      const statusChar = await service.getCharacteristic(STATUS_UUID);
      aiDevice = new AIInputDevice(device, server, controlChar, dataChar, statusChar);
      await aiDevice.startNotifications();
      return aiDevice;
    } catch (error) {
      if (aiDevice) {
        await aiDevice.disconnect();
      } else if (device.gatt && device.gatt.connected) {
        device.gatt.disconnect();
      }
      throw error;
    }
  }

  global.AIInput = AIInput;
})(typeof window !== "undefined" ? window : globalThis);
