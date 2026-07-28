import {
  RelayReassembler,
  decodeHidRelayReport,
  encodeRelayFrame,
  HID_PAYLOAD_BYTES,
  HID_REPORT_BYTES,
  splitRelayMessage,
} from "@remote-input/device-protocol";
import {
  isNotificationMessage,
  isRequestMessage,
  type NotificationMessage,
  type RequestMessage,
} from "@remote-input/protocol";
import {
  inputStatusMethod,
  parseInputCommand,
  type InputCommand,
  type InputStatus,
} from "@remote-input/sdk";

export interface HidChannel {
  onData(listener: (report: Uint8Array) => void): (() => void) | void;
  send?(report: Uint8Array): Promise<void> | void;
}

export interface ReceivedTextContext {
  requestId: number;
  transferId: number;
}

export type TextProcessor = (
  command: InputCommand,
  context: ReceivedTextContext,
  onStatus: (status: InputStatus) => void,
) => Promise<void> | void;

export class RelayAgent {
  readonly #reassembler = new RelayReassembler();
  readonly #unsubscribe: () => void;
  #queue = Promise.resolve();
  #sendQueue = Promise.resolve();
  #closed = false;
  #nextTransferId = 1;

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
      const frame = decodeHidRelayReport(report);
      const complete = this.#reassembler.accept(frame);
      if (!complete) return;
      const message: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(complete),
      );
      if (!isRequestMessage(message) && !isNotificationMessage(message)) {
        throw new Error("Agent only accepts Session input messages.");
      }
      this.#queue = this.#queue
        .then(() => this.handleRequest(message, frame.transferId))
        .catch(this.onError);
    } catch (error) {
      this.onError(error);
    }
  }

  private async handleRequest(
    request: RequestMessage | NotificationMessage,
    transferId: number,
  ): Promise<void> {
    const command = readSendText(request);
    await this.processText(
      command,
      {
        requestId: request.type === "request" ? request.requestId : 0,
        transferId,
      },
      (status) => this.sendStatus(status),
    );
  }

  private sendStatus(status: InputStatus): void {
    if (!this.hid.send || this.#closed) return;
    const payload = new TextEncoder().encode(JSON.stringify({
      type: "notify",
      method: inputStatusMethod,
      payload: status,
    }));
    const transferId = this.#nextTransferId;
    this.#nextTransferId =
      transferId === 0xffffffff ? 1 : transferId + 1;
    const reports = splitRelayMessage(
      transferId,
      payload,
      HID_PAYLOAD_BYTES,
    ).map((frame) => {
      const report = new Uint8Array(HID_REPORT_BYTES);
      report.set(encodeRelayFrame(frame));
      return report;
    });
    this.#sendQueue = this.#sendQueue
      .then(async () => {
        for (const report of reports) await this.hid.send!(report);
      })
      .catch(this.onError);
  }
}

function readSendText(
  request: RequestMessage | NotificationMessage,
): InputCommand {
  if (
    request.method !== "sendText" ||
    !request.payload
  ) {
    throw new Error(
      "Unsupported input message; expected sendText.",
    );
  }
  return parseInputCommand(request.payload);
}
