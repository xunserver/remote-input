import { CONTROL_COMMIT, CONTROL_START } from "./constants";
import { getErrorMessage, RemoteInputError } from "./errors";
import { assertTextSize, createDataFrames, decodeStatusFrame, encodeControlFrame } from "./protocol";
import type { PendingTask, RemoteBluetoothCharacteristic, RemoteBluetoothDevice, RemoteBluetoothServer, RemoteInputStatus } from "./types";

export class RemoteInputDevice {
  readonly device: RemoteBluetoothDevice;
  readonly server: RemoteBluetoothServer;
  readonly controlChar: RemoteBluetoothCharacteristic;
  readonly dataChar: RemoteBluetoothCharacteristic;
  readonly statusChar: RemoteBluetoothCharacteristic;
  taskId = 1;
  pending: PendingTask | null = null;
  connected = true;
  private statusNotificationsStarted = false;

  constructor(
    device: RemoteBluetoothDevice,
    server: RemoteBluetoothServer,
    controlChar: RemoteBluetoothCharacteristic,
    dataChar: RemoteBluetoothCharacteristic,
    statusChar: RemoteBluetoothCharacteristic,
  ) {
    this.device = device;
    this.server = server;
    this.controlChar = controlChar;
    this.dataChar = dataChar;
    this.statusChar = statusChar;
    this.onDisconnected = this.onDisconnected.bind(this);
    this.onStatusChanged = this.onStatusChanged.bind(this);
    this.device.addEventListener("gattserverdisconnected", this.onDisconnected);
  }

  async startNotifications(): Promise<void> {
    await this.statusChar.startNotifications();
    this.statusNotificationsStarted = true;
    this.statusChar.addEventListener("characteristicvaluechanged", this.onStatusChanged);
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
    const value = await this.statusChar.readValue();
    return decodeStatusFrame(value);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.rejectPending("DISCONNECTED", "Device disconnected");

    try {
      this.statusChar.removeEventListener("characteristicvaluechanged", this.onStatusChanged);
      if (this.statusNotificationsStarted && this.statusChar.stopNotifications) {
        await this.statusChar.stopNotifications();
        this.statusNotificationsStarted = false;
      }
    } catch {
      // Ignore cleanup errors during disconnect.
    }

    this.device.removeEventListener("gattserverdisconnected", this.onDisconnected);
    if (this.device.gatt?.connected) {
      this.device.gatt.disconnect();
    }
  }

  private async pumpWrites(taskId: number, startFrame: Uint8Array, frames: Uint8Array[], commitFrame: Uint8Array): Promise<void> {
    try {
      await this.controlChar.writeValueWithResponse(startFrame);
      if (!this.hasPendingTask(taskId)) return;
      for (const frame of frames) {
        await this.dataChar.writeValueWithResponse(frame);
        if (!this.hasPendingTask(taskId)) return;
      }
      if (!this.hasPendingTask(taskId)) return;
      await this.controlChar.writeValueWithResponse(commitFrame);
    } catch (error) {
      if (this.pending?.taskId === taskId) {
        this.rejectPending("BLE_WRITE_FAILED", getErrorMessage(error, "BLE write failed"), error);
      }
    }
  }

  private onStatusChanged(event: Event): void {
    let status: RemoteInputStatus;
    try {
      const target = event.target as { value?: DataView } | null;
      if (!target?.value) {
        throw new RemoteInputError("INVALID_STATUS_FRAME", "Invalid status frame");
      }
      status = decodeStatusFrame(target.value);
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
    this.connected = false;
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
