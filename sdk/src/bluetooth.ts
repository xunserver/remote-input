import { CONTROL_UUID, DATA_UUID, SERVICE_UUID, STATUS_UUID } from "./constants";
import { RemoteInputDevice } from "./device";
import { getErrorMessage, getErrorName, RemoteInputError } from "./errors";
import type { RemoteBluetoothDevice, RemoteNavigator } from "./types";

export async function connect(): Promise<RemoteInputDevice> {
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

  let remoteDevice: RemoteInputDevice | null = null;
  try {
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const controlChar = await service.getCharacteristic(CONTROL_UUID);
    const dataChar = await service.getCharacteristic(DATA_UUID);
    const statusChar = await service.getCharacteristic(STATUS_UUID);
    remoteDevice = new RemoteInputDevice(device, server, controlChar, dataChar, statusChar);
    await remoteDevice.startNotifications();
    return remoteDevice;
  } catch (error) {
    if (remoteDevice) {
      await remoteDevice.disconnect();
    } else if (device.gatt?.connected) {
      device.gatt.disconnect();
    }
    throw error;
  }
}
