import { CONTROL_COMMIT, CONTROL_START } from "./constants";
import { getErrorMessage, RemoteInputError } from "./errors";
import { assertTextSize, createDataFrames, decodeStatusFrame, encodeControlFrame } from "./protocol";
import type { RemoteInputTransport } from "./transport/types";
import type { PendingTask, RemoteInputStatus } from "./types";

export class RemoteInputClient {
  readonly transport: RemoteInputTransport;
  taskId = 1;
  pending: PendingTask | null = null;

  constructor(transport: RemoteInputTransport) {
    this.transport = transport;
    this.onDisconnected = this.onDisconnected.bind(this);
    this.onStatusChanged = this.onStatusChanged.bind(this);
    this.transport.onDisconnect(this.onDisconnected);
    this.transport.onStatus(this.onStatusChanged);
  }

  get connected(): boolean {
    return this.transport.connected;
  }

  typeText(text: string): Promise<RemoteInputStatus> {
    if (!this.connected) {
      return Promise.reject(new RemoteInputError("NOT_CONNECTED", "Device is not connected"));
    }
    if (this.pending) {
      return Promise.reject(new RemoteInputError("CLIENT_BUSY", "A typeText call is already pending"));
    }

    const bytes = new TextEncoder().encode(text);
    try {
      assertTextSize(bytes);
    } catch (error) {
      return Promise.reject(error);
    }

    const taskId = this.taskId;
    this.taskId = (this.taskId % 65535) + 1;

    const frames = createDataFrames(taskId, bytes);
    const startFrame = encodeControlFrame(CONTROL_START, taskId, bytes.byteLength, frames.length);
    const commitFrame = encodeControlFrame(CONTROL_COMMIT, taskId, bytes.byteLength, frames.length);

    const completion = new Promise<RemoteInputStatus>((resolve, reject) => {
      this.pending = { taskId, resolve, reject };
    });

    void this.pumpWrites(taskId, startFrame, frames, commitFrame);
    return completion;
  }

  async getStatus(): Promise<RemoteInputStatus> {
    if (!this.connected) {
      throw new RemoteInputError("NOT_CONNECTED", "Device is not connected");
    }
    const value = await this.transport.readStatus();
    return decodeStatusFrame(value);
  }

  async disconnect(): Promise<void> {
    this.rejectPending("DISCONNECTED", "Device disconnected");
    this.transport.offStatus(this.onStatusChanged);
    this.transport.offDisconnect(this.onDisconnected);
    await this.transport.disconnect();
  }

  private async pumpWrites(taskId: number, startFrame: Uint8Array, frames: Uint8Array[], commitFrame: Uint8Array): Promise<void> {
    try {
      await this.transport.writeControl(startFrame);
      if (!this.hasPendingTask(taskId)) return;
      for (const frame of frames) {
        await this.transport.writeData(frame);
        if (!this.hasPendingTask(taskId)) return;
      }
      if (!this.hasPendingTask(taskId)) return;
      await this.transport.writeControl(commitFrame);
    } catch (error) {
      if (this.pending?.taskId === taskId) {
        this.rejectPending(this.writeErrorCode(), getErrorMessage(error, "Transport write failed"), error);
      }
    }
  }

  private writeErrorCode(): string {
    return `${this.transport.kind.toUpperCase()}_WRITE_FAILED`;
  }

  private onStatusChanged(value: DataView): void {
    let status: RemoteInputStatus;
    try {
      status = decodeStatusFrame(value);
    } catch (error) {
      if (this.pending) {
        this.rejectPending("INVALID_STATUS_FRAME", getErrorMessage(error, "Invalid status frame"), error);
      }
      return;
    }

    if (!this.pending || status.lastTaskId !== this.pending.taskId) {
      return;
    }
    if (status.state === "done") {
      const pending = this.pending;
      this.pending = null;
      pending.resolve(status);
      return;
    }
    if (status.state === "error") {
      this.rejectPending(`DEVICE_ERROR_${status.lastErrorCode}`, "Device returned an error");
    }
  }

  private hasPendingTask(taskId: number): boolean {
    return this.pending !== null && this.pending.taskId === taskId;
  }

  private onDisconnected(): void {
    this.rejectPending("DISCONNECTED", "Device disconnected");
  }

  private rejectPending(code: string, message: string, cause?: unknown): void {
    if (!this.pending) {
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending.reject(new RemoteInputError(code, message, cause));
  }
}

export { RemoteInputClient as RemoteInputDevice };
