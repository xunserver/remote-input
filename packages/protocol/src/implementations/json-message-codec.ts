import type { MessageCodec } from "../definitions/message-codec.js";
import { maxProtocolMessageBytes, type ProtocolMessage } from "../definitions/messages.js";
import { parseProtocolMessage, ProtocolValidationError } from "./validation.js";

/** JSON Codec 的资源限制。 */
export type JsonMessageCodecOptions = {
  /** 编码或解码后的最大 UTF-8 字节数。 */
  maxMessageBytes?: number;
};

/**
 * 使用 UTF-8 JSON 的标准 MessageCodec。
 * 编解码两侧都会执行完整协议校验，解码拒绝非法 UTF-8、JSON 和消息结构。
 */
export class JsonMessageCodec implements MessageCodec {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly maxMessageBytes: number;

  /** 创建 Codec；默认采用协议定义的消息大小上限。 */
  constructor(options: JsonMessageCodecOptions = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? maxProtocolMessageBytes;
  }

  /** 校验消息并编码为 UTF-8 JSON 字节。 */
  encode(message: ProtocolMessage): Uint8Array {
    const encoded = this.encoder.encode(JSON.stringify(parseProtocolMessage(message)));
    this.requireAllowedSize(encoded);
    return encoded;
  }

  /** 解码 UTF-8 JSON，并在返回前完成运行时协议校验。 */
  decode(message: Uint8Array): ProtocolMessage {
    this.requireAllowedSize(message);
    try {
      return parseProtocolMessage(JSON.parse(this.decoder.decode(message)) as unknown);
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        throw error;
      }
      throw new ProtocolValidationError("Protocol message must contain valid UTF-8 JSON.");
    }
  }

  private requireAllowedSize(message: Uint8Array): void {
    if (message.byteLength > this.maxMessageBytes) {
      throw new ProtocolValidationError(`Protocol message exceeds ${this.maxMessageBytes} bytes.`);
    }
  }
}
