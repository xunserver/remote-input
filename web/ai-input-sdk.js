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
    constructor(code, message) {
      super(message);
      this.name = "AIInputError";
      this.code = code;
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

  const AIInput = {
    connect,
    AIInputError,
    _internals: {
      encodeControlFrame,
      createDataFrames,
      decodeStatusFrame,
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
    throw new AIInputError("WEB_BLUETOOTH_UNSUPPORTED", "Connection is implemented in the next task");
  }

  global.AIInput = AIInput;
})(typeof window !== "undefined" ? window : globalThis);
