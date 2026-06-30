import {
  CONTROL_COMMIT,
  CONTROL_START,
  DATA_FRAME,
  DATA_PAYLOAD_BYTES,
  MAX_TEXT_BYTES,
  SERVICE_UUID,
  CONTROL_UUID,
  DATA_UUID,
  STATUS_UUID,
  STATES,
  VERSION,
} from "./constants";
import { RemoteInputError } from "./errors";
import type { RemoteInputStatus } from "./types";

export function encodeControlFrame(type: number, taskId: number, totalBytes: number, totalChunks: number): Uint8Array {
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

export function createDataFrames(taskId: number, bytes: Uint8Array): Uint8Array[] {
  const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / DATA_PAYLOAD_BYTES));
  const frames: Uint8Array[] = [];

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

function createStatusObject(): RemoteInputStatus {
  const maybeWindow = (globalThis as unknown as { window?: { constructor?: { new (): object; name?: string } } }).window;
  if (maybeWindow?.constructor?.name === "Object") {
    return new maybeWindow.constructor() as RemoteInputStatus;
  }
  return {} as RemoteInputStatus;
}

export function decodeStatusFrame(buffer: ArrayBuffer | DataView): RemoteInputStatus {
  const view = buffer instanceof DataView ? buffer : new DataView(buffer);
  if (view.byteLength !== 14 || view.getUint8(0) !== VERSION) {
    throw new RemoteInputError("INVALID_STATUS_FRAME", "Invalid status frame");
  }

  const stateCode = view.getUint8(1);
  if (stateCode >= STATES.length) {
    throw new RemoteInputError("INVALID_STATUS_FRAME", "Invalid status frame");
  }

  const status = createStatusObject();
  status.state = STATES[stateCode];
  status.lastTaskId = view.getUint16(2, true);
  status.lastErrorCode = view.getUint16(4, true);
  status.receivedBytes = view.getUint32(6, true);
  status.totalBytes = view.getUint32(10, true);
  return status;
}

export function assertTextSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_TEXT_BYTES) {
    throw new RemoteInputError("TEXT_TOO_LARGE", "Text exceeds 16 KB UTF-8 limit");
  }
}

export const constants = {
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
} as const;
