import { HID_PAYLOAD_BYTES, HID_REPORT_BYTES, HID_REPORT_ID, RelayReassembler, decodeRelayFrame, encodeRelayFrame, splitRelayMessage } from "@remote-copy/device-protocol";
import { isRequestMessage, type ErrorResponseMessage, type SuccessResponseMessage } from "@remote-copy/protocol";

export interface HidChannel {
  onData(listener: (report: Uint8Array) => void): void;
  write(report: number[]): void;
  close(): void;
}
export type TextProcessor = (text: string) => Promise<void>;

export class RelayAgent {
  private readonly reassembler = new RelayReassembler();
  private responseTransferId = randomTransferId();
  private queue = Promise.resolve();

  constructor(private readonly hid: HidChannel, private readonly processText: TextProcessor, private readonly onError: (error: unknown) => void = console.error) {
    hid.onData((report) => this.acceptReport(report));
  }

  close(): void { this.hid.close(); }

  private acceptReport(report: Uint8Array): void {
    try {
      const offset = report.byteLength === HID_REPORT_BYTES + 1 && report[0] === HID_REPORT_ID ? 1 : 0;
      const complete = this.reassembler.accept(decodeRelayFrame(report.subarray(offset)));
      if (!complete) return;
      const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(complete));
      if (!isRequestMessage(message)) throw new Error("Agent only accepts Session request messages.");
      this.queue = this.queue.then(() => this.handleRequest(message)).catch(this.onError);
    } catch (error) { this.onError(error); }
  }

  private async handleRequest(request: ReturnType<typeof assertRequest>): Promise<void> {
    let response: SuccessResponseMessage | ErrorResponseMessage;
    try {
      const text = readSendText(request);
      await this.processText(text);
      response = { type: "response", requestId: request.requestId, ok: true, data: { pasted: true } };
    } catch (error) {
      response = { type: "response", requestId: request.requestId, ok: false, error: { code: "AGENT_INPUT_FAILED", message: error instanceof Error ? error.message : "Agent input failed." } };
    }
    this.send(response);
  }

  private send(message: SuccessResponseMessage | ErrorResponseMessage): void {
    const bytes = new TextEncoder().encode(JSON.stringify(message));
    const id = this.responseTransferId;
    this.responseTransferId = id === 0xffffffff ? 1 : id + 1;
    for (const frame of splitRelayMessage(id, bytes, HID_PAYLOAD_BYTES)) {
      const encoded = encodeRelayFrame(frame);
      const report = new Array<number>(HID_REPORT_BYTES + 1).fill(0);
      report[0] = HID_REPORT_ID;
      report.splice(1, encoded.byteLength, ...encoded);
      this.hid.write(report);
    }
  }
}

function assertRequest(value: unknown) { if (!isRequestMessage(value)) throw new Error("Invalid request."); return value; }
function readSendText(request: ReturnType<typeof assertRequest>): string {
  if (request.method !== "sendText" || !request.payload || typeof request.payload !== "object" || Array.isArray(request.payload) || typeof request.payload.text !== "string") throw new Error("Unsupported request; expected sendText with a string payload.");
  return request.payload.text;
}

function randomTransferId(): number {
  const values = new Uint32Array(1);
  globalThis.crypto?.getRandomValues?.(values);
  return values[0] || Math.floor(Math.random() * 0xffffffff) + 1;
}
