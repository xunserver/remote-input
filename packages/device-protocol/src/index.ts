export const RELAY_MAGIC = 0x5243;
export const RELAY_VERSION = 2;
export const RELAY_HEADER_BYTES = 16;
export const HID_REPORT_BYTES = 64;
// The wire report has no HID report ID. node-hid still requires a leading zero on writes.
export const HID_REPORT_ID = 0;
export const HID_PAYLOAD_BYTES = HID_REPORT_BYTES - RELAY_HEADER_BYTES;
export const MAX_RELAY_MESSAGE_BYTES = 256 * 1024;
export const HID_USAGE_PAGE = 0xff00;
export const HID_USAGE = 0x01;

export type RelayFrame = {
  transferId: number;
  chunkIndex: number;
  chunkCount: number;
  payload: Uint8Array;
};

export function crc16Ccitt(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function encodeRelayFrame(frame: RelayFrame): Uint8Array {
  validateFrame(frame);
  const output = new Uint8Array(RELAY_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint16(0, RELAY_MAGIC, true);
  view.setUint8(2, RELAY_VERSION);
  view.setUint8(3, 0);
  view.setUint32(4, frame.transferId, true);
  view.setUint16(8, frame.chunkIndex, true);
  view.setUint16(10, frame.chunkCount, true);
  view.setUint16(12, frame.payload.byteLength, true);
  view.setUint16(14, crc16Ccitt(frame.payload), true);
  output.set(frame.payload, RELAY_HEADER_BYTES);
  return output;
}

export function decodeRelayFrame(input: ArrayBufferView): RelayFrame {
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < RELAY_HEADER_BYTES) throw new Error("Relay frame is truncated.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== RELAY_MAGIC) throw new Error("Relay frame magic is invalid.");
  if (view.getUint8(2) !== RELAY_VERSION) throw new Error("Relay frame version is unsupported.");
  const payloadLength = view.getUint16(12, true);
  if (RELAY_HEADER_BYTES + payloadLength > bytes.byteLength) throw new Error("Relay frame payload is truncated.");
  const frame: RelayFrame = {
    transferId: view.getUint32(4, true),
    chunkIndex: view.getUint16(8, true),
    chunkCount: view.getUint16(10, true),
    payload: bytes.slice(RELAY_HEADER_BYTES, RELAY_HEADER_BYTES + payloadLength),
  };
  validateFrame(frame);
  if (view.getUint16(14, true) !== crc16Ccitt(frame.payload)) throw new Error("Relay frame CRC is invalid.");
  return frame;
}

export function splitRelayMessage(transferId: number, payload: Uint8Array, maxPayloadBytes: number): RelayFrame[] {
  if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 1) throw new RangeError("maxPayloadBytes must be positive.");
  if (payload.byteLength > MAX_RELAY_MESSAGE_BYTES) throw new RangeError("Relay message is too large.");
  const chunkCount = Math.max(1, Math.ceil(payload.byteLength / maxPayloadBytes));
  if (chunkCount > 0xffff) throw new RangeError("Relay message has too many chunks.");
  return Array.from({ length: chunkCount }, (_, chunkIndex) => ({
    transferId,
    chunkIndex,
    chunkCount,
    payload: payload.slice(chunkIndex * maxPayloadBytes, (chunkIndex + 1) * maxPayloadBytes),
  }));
}

export class RelayReassembler {
  private active: { transferId: number; chunkCount: number; chunks: Map<number, Uint8Array>; bytes: number } | undefined;
  private readonly completedTransferIds = new Set<number>();
  private readonly completedTransferOrder: number[] = [];

  accept(frame: RelayFrame): Uint8Array | undefined {
    validateFrame(frame);
    if (this.completedTransferIds.has(frame.transferId)) return undefined;
    if (!this.active || this.active.transferId !== frame.transferId) {
      this.active = { transferId: frame.transferId, chunkCount: frame.chunkCount, chunks: new Map(), bytes: 0 };
    }
    if (this.active.chunkCount !== frame.chunkCount) throw new Error("Relay chunk count changed during transfer.");
    if (!this.active.chunks.has(frame.chunkIndex)) {
      this.active.chunks.set(frame.chunkIndex, frame.payload.slice());
      this.active.bytes += frame.payload.byteLength;
      if (this.active.bytes > MAX_RELAY_MESSAGE_BYTES) {
        this.active = undefined;
        throw new RangeError("Relay message is too large.");
      }
    }
    if (this.active.chunks.size !== frame.chunkCount) return undefined;
    const output = new Uint8Array(this.active.bytes);
    let offset = 0;
    for (let index = 0; index < frame.chunkCount; index += 1) {
      const chunk = this.active.chunks.get(index);
      if (!chunk) return undefined;
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.completedTransferIds.add(frame.transferId);
    this.completedTransferOrder.push(frame.transferId);
    if (this.completedTransferOrder.length > 64) {
      const expired = this.completedTransferOrder.shift();
      if (expired !== undefined) this.completedTransferIds.delete(expired);
    }
    this.active = undefined;
    return output;
  }

  reset(): void { this.active = undefined; this.completedTransferIds.clear(); this.completedTransferOrder.length = 0; }
}

/** Decodes a fixed-size vendor HID input report into its relay frame. */
export function decodeHidRelayReport(wireReport: Uint8Array): RelayFrame {
  const report =
    wireReport.byteLength === HID_REPORT_BYTES + 1 &&
    wireReport[0] === HID_REPORT_ID
      ? wireReport.subarray(1)
      : wireReport;
  if (report.byteLength !== HID_REPORT_BYTES) {
    throw new Error(
      `Vendor HID report must contain exactly ${HID_REPORT_BYTES} bytes.`,
    );
  }
  return decodeRelayFrame(report);
}

function validateFrame(frame: RelayFrame): void {
  if (!Number.isInteger(frame.transferId) || frame.transferId < 1 || frame.transferId > 0xffffffff) throw new RangeError("transferId is invalid.");
  if (!Number.isInteger(frame.chunkCount) || frame.chunkCount < 1 || frame.chunkCount > 0xffff) throw new RangeError("chunkCount is invalid.");
  if (!Number.isInteger(frame.chunkIndex) || frame.chunkIndex < 0 || frame.chunkIndex >= frame.chunkCount) throw new RangeError("chunkIndex is invalid.");
}
