const socketIoFrameMagic = 0x5243;
const socketIoFrameVersion = 1;
const dataFrameKind = 1;
const acknowledgementFrameKind = 2;

export const socketIoDataFrameHeaderBytes = 28;
export const socketIoAcknowledgementFrameBytes = 8;
export const maxSocketIoFrameSequence = 0xffff_fffe;
export const maxSocketIoAcknowledgementSequence = 0xffff_ffff;

export type SocketIoDataFrame = {
  kind: "data";
  frameSequence: number;
  messageId: number;
  chunkIndex: number;
  chunkCount: number;
  totalMessageBytes: number;
  payload: Uint8Array;
};

export type SocketIoAcknowledgementFrame = {
  kind: "acknowledgement";
  nextExpectedFrameSequence: number;
};

export type SocketIoTransportFrame = SocketIoDataFrame | SocketIoAcknowledgementFrame;

export function encodeSocketIoDataFrame(frame: Omit<SocketIoDataFrame, "kind">): Uint8Array {
  requireUint32(frame.frameSequence, "frame sequence");
  requireUint32(frame.messageId, "message ID");
  requireUint32(frame.chunkIndex, "chunk index");
  requireUint32(frame.chunkCount, "chunk count");
  requireUint32(frame.totalMessageBytes, "total message size");
  requireUint32(frame.payload.byteLength, "payload size");

  const encoded = new Uint8Array(socketIoDataFrameHeaderBytes + frame.payload.byteLength);
  const view = new DataView(encoded.buffer);
  writePrefix(view, dataFrameKind);
  view.setUint32(4, frame.frameSequence);
  view.setUint32(8, frame.messageId);
  view.setUint32(12, frame.chunkIndex);
  view.setUint32(16, frame.chunkCount);
  view.setUint32(20, frame.totalMessageBytes);
  view.setUint32(24, frame.payload.byteLength);
  encoded.set(frame.payload, socketIoDataFrameHeaderBytes);
  return encoded;
}

export function encodeSocketIoAcknowledgementFrame(nextExpectedFrameSequence: number): Uint8Array {
  requireUint32(nextExpectedFrameSequence, "next expected frame sequence");
  const encoded = new Uint8Array(socketIoAcknowledgementFrameBytes);
  const view = new DataView(encoded.buffer);
  writePrefix(view, acknowledgementFrameKind);
  view.setUint32(4, nextExpectedFrameSequence);
  return encoded;
}

export function parseSocketIoTransportFrame(encoded: Uint8Array): SocketIoTransportFrame {
  if (encoded.byteLength < 4) {
    throw new Error("Socket.IO transport frame is shorter than its prefix.");
  }
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  if (view.getUint16(0) !== socketIoFrameMagic) {
    throw new Error("Socket.IO transport frame has an invalid magic value.");
  }
  if (view.getUint8(2) !== socketIoFrameVersion) {
    throw new Error(`Unsupported Socket.IO transport frame version: ${view.getUint8(2)}.`);
  }

  const kind = view.getUint8(3);
  if (kind === acknowledgementFrameKind) {
    if (encoded.byteLength !== socketIoAcknowledgementFrameBytes) {
      throw new Error("Socket.IO acknowledgement frame has an invalid length.");
    }
    return {
      kind: "acknowledgement",
      nextExpectedFrameSequence: view.getUint32(4),
    };
  }
  if (kind !== dataFrameKind) {
    throw new Error(`Unsupported Socket.IO transport frame kind: ${kind}.`);
  }
  if (encoded.byteLength < socketIoDataFrameHeaderBytes) {
    throw new Error("Socket.IO data frame is shorter than its header.");
  }

  const payloadBytes = view.getUint32(24);
  if (payloadBytes !== encoded.byteLength - socketIoDataFrameHeaderBytes) {
    throw new Error("Socket.IO data frame payload length does not match its header.");
  }
  const payload = new Uint8Array(payloadBytes);
  payload.set(encoded.subarray(socketIoDataFrameHeaderBytes));
  return {
    kind: "data",
    frameSequence: view.getUint32(4),
    messageId: view.getUint32(8),
    chunkIndex: view.getUint32(12),
    chunkCount: view.getUint32(16),
    totalMessageBytes: view.getUint32(20),
    payload,
  };
}

function writePrefix(view: DataView, kind: number): void {
  view.setUint16(0, socketIoFrameMagic);
  view.setUint8(2, socketIoFrameVersion);
  view.setUint8(3, kind);
}

function requireUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > maxSocketIoAcknowledgementSequence) {
    throw new Error(`Socket.IO transport ${name} must be an unsigned 32-bit integer.`);
  }
}
