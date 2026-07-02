export const RIB32_VERSION = 1;
export const RIB32_CHUNK_BYTES = 32;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CHUNK_RE = /^<RIB32:1:(\d+):(\d+):(\d+):([0-9A-Fa-f]{8}):([A-Za-z2-7]*)>$/;
const END_RE = /^<\/RIB32:1:(\d+):([0-9A-Fa-f]{8})>$/;

export type Rib32TaskStatus = "receiving" | "complete" | "error";

type StoredChunk = {
  index: number;
  total: number;
  bytes?: Uint8Array;
  crc?: number;
  errors: string[];
  conflict: boolean;
};

type Rib32TaskState = {
  taskId: number;
  order: number;
  chunkTotal?: number;
  messageCrc?: number;
  chunks: Map<number, StoredChunk>;
  lineErrors: string[];
};

export type Rib32DecoderState = {
  nextOrder: number;
  scannedLineCount: number;
  buffer: string;
  tasks: Map<number, Rib32TaskState>;
};

export type Rib32TaskView = {
  taskId: number;
  status: Rib32TaskStatus;
  chunkTotal?: number;
  receivedValidChunks: number;
  errors: string[];
  decodedBytes?: Uint8Array;
  decodedText?: string;
};

export function base32Encode(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0n;
  let bits = 0n;
  for (const byte of bytes) {
    buffer = (buffer << 8n) | BigInt(byte);
    bits += 8n;
    while (bits >= 5n) {
      output += BASE32_ALPHABET[Number((buffer >> (bits - 5n)) & 31n)];
      bits -= 5n;
    }
  }
  if (bits > 0n) {
    output += BASE32_ALPHABET[Number((buffer << (5n - bits)) & 31n)];
  }
  return output;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "").toUpperCase();
  let buffer = 0n;
  let bits = 0n;
  const out: number[] = [];
  for (const ch of clean) {
    const value = BASE32_ALPHABET.indexOf(ch);
    if (value < 0) {
      throw new Error(`Invalid Base32 character: ${ch}`);
    }
    buffer = (buffer << 5n) | BigInt(value);
    bits += 5n;
    if (bits >= 8n) {
      out.push(Number((buffer >> (bits - 8n)) & 0xffn));
      bits -= 8n;
    }
  }
  if (bits > 0n && ((buffer << (8n - bits)) & 0xffn) !== 0n) {
    throw new Error("Invalid Base32 trailing bits");
  }
  return new Uint8Array(out);
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function formatRib32Frames(taskId: number, bytes: Uint8Array): string[] {
  if (!Number.isInteger(taskId) || taskId < 1 || taskId > 65535) {
    throw new Error("taskId must be an integer from 1 to 65535");
  }
  const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / RIB32_CHUNK_BYTES));
  const lines: string[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = bytes.slice(index * RIB32_CHUNK_BYTES, (index + 1) * RIB32_CHUNK_BYTES);
    lines.push(`<RIB32:${RIB32_VERSION}:${taskId}:${index}:${totalChunks}:${hex32(crc32(chunk))}:${base32Encode(chunk)}>`);
  }
  lines.push(`</RIB32:${RIB32_VERSION}:${taskId}:${hex32(crc32(bytes))}>`);
  return lines;
}

export function createRib32DecoderState(): Rib32DecoderState {
  return { nextOrder: 0, scannedLineCount: 0, buffer: "", tasks: new Map() };
}

function taskFor(state: Rib32DecoderState, taskId: number): Rib32TaskState {
  let task = state.tasks.get(taskId);
  if (!task) {
    task = { taskId, order: state.nextOrder, chunks: new Map(), lineErrors: [] };
    state.nextOrder += 1;
    state.tasks.set(taskId, task);
  }
  return task;
}

function parseHex(value: string): number {
  return Number.parseInt(value, 16) >>> 0;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function ingestLine(state: Rib32DecoderState, rawLine: string): void {
  const line = rawLine.trim();
  if (line.length === 0) return;

  const chunkMatch = CHUNK_RE.exec(line);
  if (chunkMatch) {
    const taskId = Number(chunkMatch[1]);
    const index = Number(chunkMatch[2]);
    const total = Number(chunkMatch[3]);
    const expectedCrc = parseHex(chunkMatch[4]);
    const payload = chunkMatch[5];
    const task = taskFor(state, taskId);
    task.chunkTotal = task.chunkTotal ?? total;
    if (task.chunkTotal !== total) task.lineErrors.push(`task ${taskId} chunk total changed`);

    let chunk: StoredChunk = task.chunks.get(index) ?? { index, total, errors: [], conflict: false };
    const errors: string[] = [];
    let bytes: Uint8Array | undefined;
    try {
      bytes = base32Decode(payload);
      if (crc32(bytes) !== expectedCrc) errors.push(`chunk ${index} crc mismatch`);
    } catch (error) {
      errors.push(`chunk ${index} ${(error as Error).message}`);
    }

    if (bytes && errors.length === 0) {
      if (!chunk.bytes || chunk.errors.length > 0) {
        chunk = { index, total, bytes, crc: expectedCrc, errors: [], conflict: false };
      } else if (chunk.crc !== expectedCrc || !equalBytes(chunk.bytes, bytes)) {
        chunk.conflict = true;
        chunk.errors = [`chunk ${index} conflict`];
      }
    } else if (!chunk.bytes) {
      chunk = { index, total, errors, conflict: false };
    }
    task.chunks.set(index, chunk);
    return;
  }

  const endMatch = END_RE.exec(line);
  if (endMatch) {
    const taskId = Number(endMatch[1]);
    const task = taskFor(state, taskId);
    task.messageCrc = parseHex(endMatch[2]);
    return;
  }

  const synthetic = taskFor(state, 0);
  synthetic.lineErrors.push(`unrecognized line ${state.scannedLineCount + 1}`);
}

export function ingestRib32Text(state: Rib32DecoderState, text: string): Rib32DecoderState {
  state.buffer += text;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? "";
  for (const line of lines) {
    ingestLine(state, line);
    state.scannedLineCount += 1;
  }
  return state;
}

export function getRib32Tasks(state: Rib32DecoderState): Rib32TaskView[] {
  return Array.from(state.tasks.values())
    .filter((task) => task.taskId !== 0)
    .sort((a, b) => a.order - b.order)
    .map(viewTask);
}

function viewTask(task: Rib32TaskState): Rib32TaskView {
  const errors = [...task.lineErrors];
  const total = task.chunkTotal;
  const validChunks: Uint8Array[] = [];
  if (total !== undefined) {
    for (let index = 0; index < total; index += 1) {
      const chunk = task.chunks.get(index);
      if (!chunk) {
        errors.push(`missing chunk ${index}`);
      } else if (chunk.errors.length > 0 || chunk.conflict) {
        errors.push(...chunk.errors);
      } else if (chunk.bytes) {
        validChunks[index] = chunk.bytes;
      }
    }
  }
  if (task.messageCrc === undefined) {
    return {
      taskId: task.taskId,
      status: errors.length ? "error" : "receiving",
      chunkTotal: total,
      receivedValidChunks: validChunks.filter(Boolean).length,
      errors,
    };
  }
  if (total === undefined) errors.push("missing chunk total");
  if (errors.length > 0 || total === undefined) {
    return {
      taskId: task.taskId,
      status: "error",
      chunkTotal: total,
      receivedValidChunks: validChunks.filter(Boolean).length,
      errors,
    };
  }
  const decodedBytes = joinChunks(validChunks);
  if (crc32(decodedBytes) !== task.messageCrc) {
    return {
      taskId: task.taskId,
      status: "error",
      chunkTotal: total,
      receivedValidChunks: validChunks.length,
      errors: ["message crc mismatch"],
    };
  }
  try {
    const decodedText = new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes);
    return {
      taskId: task.taskId,
      status: "complete",
      chunkTotal: total,
      receivedValidChunks: validChunks.length,
      errors: [],
      decodedBytes,
      decodedText,
    };
  } catch {
    return {
      taskId: task.taskId,
      status: "error",
      chunkTotal: total,
      receivedValidChunks: validChunks.length,
      errors: ["invalid utf-8"],
    };
  }
}
