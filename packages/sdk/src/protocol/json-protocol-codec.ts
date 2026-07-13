import {
  parseProtocolMessage,
  ProtocolValidationError,
  type ProtocolMessage,
} from "@remote-copy/shared";

export interface ProtocolCodec {
  encode(message: ProtocolMessage): Uint8Array;
  decode(message: Uint8Array): ProtocolMessage;
}

export class JsonProtocolCodec implements ProtocolCodec {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  encode(message: ProtocolMessage): Uint8Array {
    return this.encoder.encode(JSON.stringify(message));
  }

  decode(message: Uint8Array): ProtocolMessage {
    try {
      return parseProtocolMessage(JSON.parse(this.decoder.decode(message)) as unknown);
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        throw error;
      }

      throw new ProtocolValidationError("Protocol message must contain valid UTF-8 JSON.");
    }
  }
}
