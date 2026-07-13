import type { Socket } from "node:net";

export type ParsedFrame =
  | {
      opcode: 0x1;
      text: string;
    }
  | {
      opcode: 0x8 | 0x9;
    };

export function sendJsonFrame(socket: Socket, payload: unknown): void {
  if (socket.destroyed) {
    return;
  }

  const data = Buffer.from(JSON.stringify(payload));
  let header: Buffer;

  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  socket.write(Buffer.concat([header, data]));
}

export function parseFrames(buffer: Buffer): { frames: ParsedFrame[]; rest: Buffer } {
  const frames: ParsedFrame[] = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const frameStart = offset;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    offset += 2;

    if (length === 126) {
      if (buffer.length - offset < 2) {
        return { frames, rest: buffer.subarray(frameStart) };
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length - offset < 8) {
        return { frames, rest: buffer.subarray(frameStart) };
      }
      const bigLength = buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket message is too large.");
      }
      length = Number(bigLength);
      offset += 8;
    }

    let mask: Buffer | undefined;
    if (masked) {
      if (buffer.length - offset < 4) {
        return { frames, rest: buffer.subarray(frameStart) };
      }
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length - offset < length) {
      return { frames, rest: buffer.subarray(frameStart) };
    }

    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    offset += length;

    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    if (opcode === 0x1) {
      frames.push({ opcode: 0x1, text: payload.toString("utf8") });
    } else if (opcode === 0x8 || opcode === 0x9) {
      frames.push({ opcode });
    }
  }

  return { frames, rest: buffer.subarray(offset) };
}
