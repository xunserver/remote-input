import { maxProtocolMessageBytes, type ProtocolMessage } from "./messages.js";
import { parseProtocolMessage, ProtocolValidationError } from "./validation.js";

export interface MessageCodec {
  encode(message: ProtocolMessage): Uint8Array;
  decode(message: Uint8Array): ProtocolMessage;
}

export type JsonMessageCodecOptions = {
  maxMessageBytes?: number;
};

export class JsonMessageCodec implements MessageCodec {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly maxMessageBytes: number;

  constructor(options: JsonMessageCodecOptions = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? maxProtocolMessageBytes;
  }

  encode(message: ProtocolMessage): Uint8Array {
    const encoded = this.encoder.encode(JSON.stringify(parseProtocolMessage(message)));
    this.requireAllowedSize(encoded);
    return encoded;
  }

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
