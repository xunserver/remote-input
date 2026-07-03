import { CONTROL_UUID, DATA_UUID, SERVICE_UUID, STATUS_UUID } from "../constants";
import { RemoteInputClient } from "../device";
import { getErrorMessage, getErrorName, RemoteInputError } from "../errors";
import type {
  RemoteInputConfig,
  RemoteBluetoothCharacteristic,
  RemoteBluetoothDevice,
  RemoteBluetoothServer,
  RemoteNavigator,
} from "../types";
import type {
  RemoteInputDisconnectListener,
  RemoteInputStatusListener,
  RemoteInputTransport,
} from "./types";

export class BleTransport implements RemoteInputTransport {
  readonly kind = "ble";
  readonly device: RemoteBluetoothDevice;
  readonly server: RemoteBluetoothServer;
  readonly controlChar: RemoteBluetoothCharacteristic;
  readonly dataChar: RemoteBluetoothCharacteristic;
  readonly statusChar: RemoteBluetoothCharacteristic;
  private statusListeners = new Set<RemoteInputStatusListener>();
  private disconnectListeners = new Set<RemoteInputDisconnectListener>();
  private statusNotificationsStarted = false;
  private isConnected = true;

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
    this.handleDisconnected = this.handleDisconnected.bind(this);
    this.handleStatusChanged = this.handleStatusChanged.bind(this);
    this.device.addEventListener("gattserverdisconnected", this.handleDisconnected);
  }

  get connected(): boolean {
    return this.isConnected;
  }

  async startNotifications(): Promise<void> {
    await this.statusChar.startNotifications();
    this.statusNotificationsStarted = true;
    this.statusChar.addEventListener("characteristicvaluechanged", this.handleStatusChanged);
  }

  writeControl(frame: Uint8Array): Promise<void> {
    return this.controlChar.writeValueWithResponse(frame);
  }

  writeData(frame: Uint8Array): Promise<void> {
    if (this.dataChar.writeValueWithoutResponse) {
      return this.dataChar.writeValueWithoutResponse(frame);
    }
    return this.dataChar.writeValueWithResponse(frame);
  }

  readStatus(): Promise<DataView> {
    return this.statusChar.readValue();
  }

  onStatus(listener: RemoteInputStatusListener): void {
    this.statusListeners.add(listener);
  }

  offStatus(listener: RemoteInputStatusListener): void {
    this.statusListeners.delete(listener);
  }

  onDisconnect(listener: RemoteInputDisconnectListener): void {
    this.disconnectListeners.add(listener);
  }

  offDisconnect(listener: RemoteInputDisconnectListener): void {
    this.disconnectListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;

    try {
      this.statusChar.removeEventListener("characteristicvaluechanged", this.handleStatusChanged);
      if (this.statusNotificationsStarted && this.statusChar.stopNotifications) {
        await this.statusChar.stopNotifications();
        this.statusNotificationsStarted = false;
      }
    } catch {
      // Ignore cleanup errors during disconnect.
    }

    this.device.removeEventListener("gattserverdisconnected", this.handleDisconnected);
    if (this.device.gatt?.connected) {
      this.device.gatt.disconnect();
    }
  }

  private handleStatusChanged(event: Event): void {
    const target = event.target as { value?: DataView } | null;
    if (!target?.value) {
      for (const listener of this.statusListeners) {
        listener(new DataView(new ArrayBuffer(0)));
      }
      return;
    }

    for (const listener of this.statusListeners) {
      listener(target.value);
    }
  }

  private handleDisconnected(): void {
    this.isConnected = false;
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}

export interface ConnectBleOptions {
  config?: RemoteInputConfig;
}

function isGattDisconnectedError(error: unknown): boolean {
  return /GATT Server is disconnected/i.test(getErrorMessage(error, ""));
}

export async function connectBle(options: ConnectBleOptions = {}): Promise<RemoteInputClient> {
  const remoteNavigator = navigator as RemoteNavigator;
  if (!remoteNavigator.bluetooth) {
    throw new RemoteInputError("WEB_BLUETOOTH_UNSUPPORTED", "Web Bluetooth is not available");
  }

  let device: RemoteBluetoothDevice;
  try {
    device = await remoteNavigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });
  } catch (error) {
    if (getErrorName(error) === "NotFoundError") {
      throw new RemoteInputError("DEVICE_SELECTION_CANCELLED", getErrorMessage(error, "Device selection cancelled"), error);
    }
    throw new RemoteInputError("DEVICE_REQUEST_FAILED", getErrorMessage(error, "Device request failed"), error);
  }

  let transport: BleTransport | null = null;
  try {
    let server = await device.gatt!.connect();
    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
    } catch (error) {
      if (!isGattDisconnectedError(error)) {
        throw error;
      }
      server = await device.gatt!.connect();
      service = await server.getPrimaryService(SERVICE_UUID);
    }
    const controlChar = await service.getCharacteristic(CONTROL_UUID);
    const dataChar = await service.getCharacteristic(DATA_UUID);
    const statusChar = await service.getCharacteristic(STATUS_UUID);
    transport = new BleTransport(device, server, controlChar, dataChar, statusChar);
    await transport.startNotifications();
    const client = new RemoteInputClient(transport);
    if (options.config) {
      await client.setConfig(options.config);
    }
    return client;
  } catch (error) {
    if (transport) {
      await transport.disconnect();
    } else if (device.gatt?.connected) {
      device.gatt.disconnect();
    }
    throw new RemoteInputError("BLE_CONNECT_FAILED", getErrorMessage(error, "Bluetooth connection failed"), error);
  }
}
