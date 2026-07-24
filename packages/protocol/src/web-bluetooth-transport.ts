import { HID_PAYLOAD_BYTES, RelayReassembler, decodeRelayFrame, encodeRelayFrame, splitRelayMessage } from "@remote-copy/device-protocol";
import { SDKError, sdkErrorCodes } from "./errors.js";
import { snapshotJsonValue } from "./json.js";
import { isSessionMessage, type SessionMessage } from "./messages.js";
import type { Transport, TransportReceiver, TransportSendOptions, TransportState } from "./transport.js";

export const REMOTE_COPY_BLE_SERVICE = "7c6b0001-6d5a-4f4f-9d2d-5f6f74656368";
export const REMOTE_COPY_BLE_WRITE = "7c6b0002-6d5a-4f4f-9d2d-5f6f74656368";
export const REMOTE_COPY_BLE_NOTIFY = "7c6b0003-6d5a-4f4f-9d2d-5f6f74656368";

type EventListener = (event: any) => void;
export interface BluetoothCharacteristicLike {
  value?: DataView;
  startNotifications(): Promise<BluetoothCharacteristicLike>;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  addEventListener(type: "characteristicvaluechanged", listener: EventListener): void;
  removeEventListener(type: "characteristicvaluechanged", listener: EventListener): void;
}
export interface BluetoothDeviceLike {
  readonly name?: string;
  readonly gatt?: { connected: boolean; connect(): Promise<{ getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<BluetoothCharacteristicLike> }> }>; disconnect(): void };
  addEventListener(type: "gattserverdisconnected", listener: EventListener): void;
  removeEventListener(type: "gattserverdisconnected", listener: EventListener): void;
}
export type BluetoothDeviceRequest = () => Promise<BluetoothDeviceLike>;
export type BluetoothTransportStateListener = (state: TransportState) => void;
export type WebBluetoothSupport =
  | { supported: true }
  | { supported: false; reason: "insecure_context" | "unavailable" };
export interface WebBluetoothEnvironment {
  isSecureContext: boolean | undefined;
  bluetooth: { requestDevice(options: unknown): Promise<BluetoothDeviceLike> } | undefined;
}

export function getWebBluetoothSupport(environment: WebBluetoothEnvironment = browserEnvironment()): WebBluetoothSupport {
  if (environment.isSecureContext === false) return { supported: false, reason: "insecure_context" };
  if (!environment.bluetooth) return { supported: false, reason: "unavailable" };
  return { supported: true };
}

export class WebBluetoothTransport implements Transport {
  private receiver: TransportReceiver | undefined;
  private device: BluetoothDeviceLike | undefined;
  private writeCharacteristic: BluetoothCharacteristicLike | undefined;
  private notifyCharacteristic: BluetoothCharacteristicLike | undefined;
  private readonly reassembler = new RelayReassembler();
  private readonly listeners = new Set<BluetoothTransportStateListener>();
  private stateValue: TransportState = "idle";
  private nextTransferId = randomTransferId();
  private sendTail = Promise.resolve();

  constructor(private readonly requestDevice: BluetoothDeviceRequest = defaultRequestDevice) {}
  get state(): TransportState { return this.stateValue; }
  subscribe(listener: BluetoothTransportStateListener): () => void { this.listeners.add(listener); listener(this.stateValue); return () => this.listeners.delete(listener); }
  bind(receiver: TransportReceiver): void { if (this.receiver && this.receiver !== receiver) throw new Error("Transport is already bound."); this.receiver = receiver; }
  unbind(receiver: TransportReceiver): void { if (this.receiver === receiver) this.receiver = undefined; }

  async connect(): Promise<void> {
    if (this.stateValue === "connected") return;
    if (this.stateValue === "closed" || this.stateValue === "closing") throw new Error("Transport is closed.");
    this.setState("connecting");
    try {
      const device = await this.requestDevice();
      if (!device.gatt) throw new Error("Selected Bluetooth device has no GATT server.");
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(REMOTE_COPY_BLE_SERVICE);
      const [write, notify] = await Promise.all([service.getCharacteristic(REMOTE_COPY_BLE_WRITE), service.getCharacteristic(REMOTE_COPY_BLE_NOTIFY)]);
      await notify.startNotifications();
      this.device = device; this.writeCharacteristic = write; this.notifyCharacteristic = notify;
      device.addEventListener("gattserverdisconnected", this.onDisconnected);
      notify.addEventListener("characteristicvaluechanged", this.onNotification);
      this.setState("connected");
    } catch (cause) {
      this.setState("idle");
      throw new SDKError(sdkErrorCodes.transportNotConnected, "Unable to connect to Bluetooth device.", "not_sent", { cause });
    }
  }

  send(message: SessionMessage, options: TransportSendOptions = {}): Promise<void> {
    if (this.stateValue !== "connected" || !this.writeCharacteristic) return Promise.reject(new SDKError(sdkErrorCodes.transportNotConnected, "Bluetooth is not connected.", "not_sent"));
    let bytes: Uint8Array;
    try { bytes = new TextEncoder().encode(JSON.stringify(snapshotJsonValue(message))); }
    catch (cause) { return Promise.reject(new SDKError(sdkErrorCodes.encodeError, "Unable to encode message.", "not_sent", { cause })); }
    const frames = splitRelayMessage(this.allocateTransferId(), bytes, HID_PAYLOAD_BYTES).map(encodeRelayFrame);
    const work = this.sendTail.then(async () => {
      for (const frame of frames) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (this.stateValue !== "connected" || !this.writeCharacteristic) throw new SDKError(sdkErrorCodes.transportDisconnected, "Bluetooth disconnected while sending.", "unknown");
        await this.writeCharacteristic.writeValueWithResponse(new Uint8Array(frame).buffer);
        options.onDeliveryChange?.("unknown");
      }
    });
    this.sendTail = work.catch(() => undefined);
    return work;
  }

  async close(): Promise<void> {
    if (this.stateValue === "closed") return;
    this.setState("closing"); this.detach(); this.device?.gatt?.disconnect(); this.device = undefined;
    this.setState("closed"); this.receiver?.localClosed();
  }

  private readonly onNotification = (event: any): void => {
    try {
      const value = event?.target?.value ?? this.notifyCharacteristic?.value;
      if (!value) return;
      const complete = this.reassembler.accept(decodeRelayFrame(value));
      if (!complete) return;
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(complete));
      if (!isSessionMessage(parsed)) throw new Error("Relay payload is not a Session message.");
      this.receiver?.accept(parsed);
    } catch (cause) { console.error("Ignored invalid Bluetooth relay frame.", cause); }
  };
  private readonly onDisconnected = (): void => {
    if (this.stateValue !== "connected" && this.stateValue !== "connecting") return;
    this.detach(); this.setState("idle");
    this.receiver?.disconnected(new SDKError(sdkErrorCodes.transportDisconnected, "Bluetooth device disconnected.", "unknown"));
  };
  private detach(): void { this.notifyCharacteristic?.removeEventListener("characteristicvaluechanged", this.onNotification); this.device?.removeEventListener("gattserverdisconnected", this.onDisconnected); this.notifyCharacteristic = undefined; this.writeCharacteristic = undefined; this.reassembler.reset(); }
  private setState(state: TransportState): void { this.stateValue = state; for (const listener of this.listeners) listener(state); }
  private allocateTransferId(): number { const id = this.nextTransferId; this.nextTransferId = id === 0xffffffff ? 1 : id + 1; return id; }
}

async function defaultRequestDevice(): Promise<BluetoothDeviceLike> {
  const environment = browserEnvironment();
  const support = getWebBluetoothSupport(environment);
  if (!support.supported) {
    throw new Error(support.reason === "insecure_context"
      ? "Web Bluetooth requires HTTPS or localhost."
      : "Web Bluetooth is unavailable in this browser.");
  }
  const bluetooth = environment.bluetooth;
  if (!bluetooth) throw new Error("Web Bluetooth is unavailable in this browser.");
  return bluetooth.requestDevice({ filters: [{ services: [REMOTE_COPY_BLE_SERVICE] }] });
}

function browserEnvironment(): WebBluetoothEnvironment {
  const browserNavigator = typeof navigator === "undefined"
    ? undefined
    : navigator as Navigator & { bluetooth?: WebBluetoothEnvironment["bluetooth"] };
  return {
    isSecureContext: globalThis.isSecureContext,
    bluetooth: browserNavigator?.bluetooth,
  };
}

function randomTransferId(): number {
  const values = new Uint32Array(1);
  globalThis.crypto?.getRandomValues?.(values);
  return values[0] || Math.floor(Math.random() * 0xffffffff) + 1;
}
