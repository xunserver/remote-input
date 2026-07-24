import {
  HID_PAYLOAD_BYTES,
  HID_REPORT_BYTES,
  HID_REPORT_ID,
  RelayReassembler,
  decodeRelayFrame,
  encodeRelayFrame,
  splitRelayMessage,
} from "@remote-copy/device-protocol";
import {
  isRequestMessage,
  type ErrorResponseMessage,
  type RequestMessage,
  type SuccessResponseMessage,
} from "@remote-copy/protocol";

export interface HidChannel {
  onData(listener: (report: Uint8Array) => void): (() => void) | void;
  write(report: Uint8Array): Promise<void> | void;
}

export interface ReceivedTextContext {
  requestId: number;
  transferId: number;
}

export type TextProcessor = (
  text: string,
  context: ReceivedTextContext,
) => Promise<void> | void;

export class RelayAgent {
  readonly #reassembler = new RelayReassembler();
  readonly #unsubscribe: () => void;
  #responseTransferId = randomTransferId();
  #queue = Promise.resolve();
  #closed = false;

  constructor(
    private readonly hid: HidChannel,
    private readonly processText: TextProcessor,
    private readonly onError: (error: unknown) => void = console.error,
  ) {
    this.#unsubscribe =
      hid.onData((report) => this.acceptReport(report)) ?? (() => undefined);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#reassembler.reset();
  }

  private acceptReport(report: Uint8Array): void {
    if (this.#closed) return;
    try {
      const offset =
        report.byteLength === HID_REPORT_BYTES + 1 &&
        report[0] === HID_REPORT_ID
          ? 1
          : 0;
      const frame = decodeRelayFrame(report.subarray(offset));
      const complete = this.#reassembler.accept(frame);
      if (!complete) return;
      const message: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(complete),
      );
      if (!isRequestMessage(message)) {
        throw new Error("Agent only accepts Session request messages.");
      }
      this.#queue = this.#queue
        .then(() => this.handleRequest(message, frame.transferId))
        .catch(this.onError);
    } catch (error) {
      this.onError(error);
    }
  }

  private async handleRequest(
    request: RequestMessage,
    transferId: number,
  ): Promise<void> {
    let response: SuccessResponseMessage | ErrorResponseMessage;
    try {
      const text = readSendText(request);
      await this.processText(text, { requestId: request.requestId, transferId });
      response = {
        type: "response",
        requestId: request.requestId,
        ok: true,
        data: { pasted: true },
      };
    } catch (error) {
      response = {
        type: "response",
        requestId: request.requestId,
        ok: false,
        error: {
          code: "AGENT_INPUT_FAILED",
          message:
            error instanceof Error ? error.message : "Agent input failed.",
        },
      };
    }
    await this.send(response);
  }

  private async send(
    message: SuccessResponseMessage | ErrorResponseMessage,
  ): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(message));
    const id = this.#responseTransferId;
    this.#responseTransferId = id === 0xffffffff ? 1 : id + 1;
    for (const frame of splitRelayMessage(id, bytes, HID_PAYLOAD_BYTES)) {
      const encoded = encodeRelayFrame(frame);
      const report = new Uint8Array(HID_REPORT_BYTES);
      report.set(encoded);
      await this.hid.write(report);
    }
  }
}

function readSendText(request: RequestMessage): string {
  if (
    request.method !== "sendText" ||
    !request.payload ||
    typeof request.payload !== "object" ||
    Array.isArray(request.payload) ||
    typeof request.payload.text !== "string"
  ) {
    throw new Error(
      "Unsupported request; expected sendText with a string payload.",
    );
  }
  return request.payload.text;
}

function randomTransferId(): number {
  const values = new Uint32Array(1);
  globalThis.crypto?.getRandomValues?.(values);
  return values[0] || Math.floor(Math.random() * 0xffffffff) + 1;
}
