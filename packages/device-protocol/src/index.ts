export const RELAY_MAGIC = 0x5243;
export const RELAY_VERSION = 2;
export const RELAY_HEADER_BYTES = 16;
export const HID_REPORT_BYTES = 64;
// The wire report has no HID report ID. node-hid still requires a leading zero on writes.
export const HID_REPORT_ID = 0;
export const HID_PAYLOAD_BYTES = HID_REPORT_BYTES - RELAY_HEADER_BYTES;
export const MAX_RELAY_MESSAGE_BYTES = 256 * 1024;
export const KEYBOARD_REPORT_BYTES = 8;
export const KEYBOARD_USAGE_PAGE = 0x01;
export const KEYBOARD_USAGE = 0x06;

// Standard Keyboard/Keypad usage IDs F13-F19.
const KEYBOARD_MARKER_KEY = 0x68;
const KEYBOARD_HIGH_PHASE_KEY = 0x69;
const KEYBOARD_LOW_PHASE_KEY = 0x6a;
const KEYBOARD_BIT_KEYS = [0x6b, 0x6c, 0x6d, 0x6e] as const;

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

/**
 * Encodes each relay-frame byte as high/low nibble chords made exclusively
 * from the standard F13-F19 keyboard usages.
 */
export class KeyboardReportEncoder {
  encode(frame: RelayFrame): Uint8Array[] {
    const encoded = encodeRelayFrame(frame);
    const reports = Array.from(encoded, (byte) => [
      encodeKeyboardNibble(byte >>> 4, KEYBOARD_HIGH_PHASE_KEY),
      encodeKeyboardNibble(byte & 0x0f, KEYBOARD_LOW_PHASE_KEY),
    ]).flat();
    reports.push(new Uint8Array(KEYBOARD_REPORT_BYTES));
    return reports;
  }
}

/** Decodes and validates relay frames carried by standard keyboard reports. */
export class KeyboardReportDecoder {
  private highNibble: number | undefined;
  private frameBytes: number[] = [];
  private expectedFrameBytes: number | undefined;

  accept(wireReport: Uint8Array): RelayFrame | undefined {
    const report = normalizeKeyboardReport(wireReport);
    if (report.every((byte) => byte === 0)) {
      this.highNibble = undefined;
      if (this.frameBytes.length !== 0) this.resetFrame();
      return undefined;
    }
    const decoded = decodeKeyboardNibble(report);
    if (!decoded) {
      this.resetFrame();
      this.highNibble = undefined;
      return undefined;
    }
    if (decoded.phase === "high") {
      this.highNibble = decoded.nibble;
      return undefined;
    }
    if (this.highNibble === undefined) {
      this.resetFrame();
      return undefined;
    }
    const byte = (this.highNibble << 4) | decoded.nibble;
    this.highNibble = undefined;
    return this.acceptByte(byte);
  }

  reset(): void {
    this.highNibble = undefined;
    this.resetFrame();
  }

  private acceptByte(byte: number): RelayFrame | undefined {
    if (this.frameBytes.length === 0) {
      if (byte === (RELAY_MAGIC & 0xff)) this.frameBytes.push(byte);
      return undefined;
    }
    if (this.frameBytes.length === 1) {
      if (byte === (RELAY_MAGIC >>> 8)) {
        this.frameBytes.push(byte);
      } else {
        this.frameBytes = byte === (RELAY_MAGIC & 0xff) ? [byte] : [];
      }
      return undefined;
    }

    this.frameBytes.push(byte);
    if (this.frameBytes.length === RELAY_HEADER_BYTES) {
      const payloadLength = this.frameBytes[12]! | (this.frameBytes[13]! << 8);
      const total = RELAY_HEADER_BYTES + payloadLength;
      if (payloadLength > HID_PAYLOAD_BYTES || total > HID_REPORT_BYTES) {
        this.resetFrame();
        return undefined;
      }
      this.expectedFrameBytes = total;
    }
    if (
      this.expectedFrameBytes === undefined ||
      this.frameBytes.length < this.expectedFrameBytes
    ) {
      return undefined;
    }

    const encoded = Uint8Array.from(this.frameBytes);
    this.resetFrame();
    return decodeRelayFrame(encoded);
  }

  private resetFrame(): void {
    this.frameBytes = [];
    this.expectedFrameBytes = undefined;
  }
}

function validateFrame(frame: RelayFrame): void {
  if (!Number.isInteger(frame.transferId) || frame.transferId < 1 || frame.transferId > 0xffffffff) throw new RangeError("transferId is invalid.");
  if (!Number.isInteger(frame.chunkCount) || frame.chunkCount < 1 || frame.chunkCount > 0xffff) throw new RangeError("chunkCount is invalid.");
  if (!Number.isInteger(frame.chunkIndex) || frame.chunkIndex < 0 || frame.chunkIndex >= frame.chunkCount) throw new RangeError("chunkIndex is invalid.");
}

function encodeKeyboardNibble(nibble: number, phaseKey: number): Uint8Array {
  const report = new Uint8Array(KEYBOARD_REPORT_BYTES);
  report[2] = KEYBOARD_MARKER_KEY;
  report[3] = phaseKey;
  let position = 4;
  for (let bit = 0; bit < KEYBOARD_BIT_KEYS.length; bit += 1) {
    if ((nibble & (1 << (3 - bit))) !== 0) {
      report[position++] = KEYBOARD_BIT_KEYS[bit]!;
    }
  }
  return report;
}

function decodeKeyboardNibble(
  report: Uint8Array,
): { phase: "high" | "low"; nibble: number } | undefined {
  if (report[0] !== 0 || report[1] !== 0) return undefined;
  const keys = Array.from(report.slice(2)).filter((key) => key !== 0);
  if (new Set(keys).size !== keys.length || !keys.includes(KEYBOARD_MARKER_KEY)) {
    return undefined;
  }
  const high = keys.includes(KEYBOARD_HIGH_PHASE_KEY);
  const low = keys.includes(KEYBOARD_LOW_PHASE_KEY);
  if (high === low) return undefined;
  let nibble = 0;
  for (let bit = 0; bit < KEYBOARD_BIT_KEYS.length; bit += 1) {
    if (keys.includes(KEYBOARD_BIT_KEYS[bit]!)) nibble |= 1 << (3 - bit);
  }
  const allowed = new Set([
    KEYBOARD_MARKER_KEY,
    high ? KEYBOARD_HIGH_PHASE_KEY : KEYBOARD_LOW_PHASE_KEY,
    ...KEYBOARD_BIT_KEYS,
  ]);
  if (keys.some((key) => !allowed.has(key))) return undefined;
  return { phase: high ? "high" : "low", nibble };
}

function normalizeKeyboardReport(wireReport: Uint8Array): Uint8Array {
  if (
    wireReport.byteLength === KEYBOARD_REPORT_BYTES + 1 &&
    wireReport[0] === HID_REPORT_ID
  ) {
    return wireReport.subarray(1);
  }
  if (wireReport.byteLength !== KEYBOARD_REPORT_BYTES) {
    throw new Error("Standard keyboard report must contain exactly 8 bytes.");
  }
  return wireReport;
}
