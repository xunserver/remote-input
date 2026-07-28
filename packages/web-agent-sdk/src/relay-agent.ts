import {
  KeyboardReportDecoder,
  RelayReassembler,
} from "@remote-input/device-protocol";
import {
  isRequestMessage,
  type RequestMessage,
} from "@remote-input/protocol";

export interface HidChannel {
  onData(listener: (report: Uint8Array) => void): (() => void) | void;
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
  readonly #keyboardDecoder = new KeyboardReportDecoder();
  readonly #unsubscribe: () => void;
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
    this.#keyboardDecoder.reset();
  }

  private acceptReport(report: Uint8Array): void {
    if (this.#closed) return;
    try {
      const frame = this.#keyboardDecoder.accept(report);
      if (!frame) return;
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
    const text = readSendText(request);
    await this.processText(text, { requestId: request.requestId, transferId });
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
