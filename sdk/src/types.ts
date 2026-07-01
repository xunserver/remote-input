export interface RemoteInputStatus {
  state: string;
  lastTaskId: number;
  lastErrorCode: number;
  receivedBytes: number;
  totalBytes: number;
}

export interface RemoteInputConfig {
  keyDelayMs: number;
}

export interface PendingTask {
  taskId: number;
  resolve: (status: RemoteInputStatus) => void;
  reject: (error: Error) => void;
}

export interface RemoteBluetoothCharacteristic extends EventTarget {
  writeValueWithResponse(value: Uint8Array): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<RemoteBluetoothCharacteristic>;
  stopNotifications?: () => Promise<RemoteBluetoothCharacteristic>;
}

export interface RemoteBluetoothService {
  getCharacteristic(uuid: string): Promise<RemoteBluetoothCharacteristic>;
}

export interface RemoteBluetoothServer {
  connected?: boolean;
  connect(): Promise<RemoteBluetoothServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<RemoteBluetoothService>;
}

export interface RemoteBluetoothDevice extends EventTarget {
  gatt?: RemoteBluetoothServer;
}

export interface RemoteBluetooth {
  requestDevice(options: {
    filters: Array<{ services: string[] }>;
    optionalServices: string[];
  }): Promise<RemoteBluetoothDevice>;
}

export interface RemoteNavigator extends Navigator {
  bluetooth?: RemoteBluetooth;
}

export interface RemoteWebSocketEventMap {
  open: Event;
  close: CloseEvent;
  error: Event;
  message: MessageEvent;
}

export interface RemoteWebSocket {
  readonly readyState: number;
  binaryType: BinaryType;
  addEventListener<K extends keyof RemoteWebSocketEventMap>(
    type: K,
    listener: (event: RemoteWebSocketEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof RemoteWebSocketEventMap>(
    type: K,
    listener: (event: RemoteWebSocketEventMap[K]) => void,
  ): void;
  send(data: Uint8Array): void;
  close(): void;
}

export interface RemoteWebSocketConstructor {
  readonly OPEN: number;
  new (url: string): RemoteWebSocket;
}
