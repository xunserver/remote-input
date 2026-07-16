/** Socket.IO 层唯一承载 Transport DATA/ACK 二进制帧的事件名。 */
export const protocolSocketEvent = "protocol:frame" as const;

/** 将 Socket.IO 支持的二进制形态归一为 Uint8Array 视图。 */
export function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Socket.IO transport frame must be binary data.");
}

/** 复制消息，避免发送方或 Socket.IO 缓冲区后续修改共享内存。 */
export function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}
