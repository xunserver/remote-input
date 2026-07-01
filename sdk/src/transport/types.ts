export type RemoteInputStatusListener = (value: DataView) => void;
export type RemoteInputDisconnectListener = () => void;

export interface RemoteInputTransport {
  readonly kind: string;
  readonly connected: boolean;

  writeControl(frame: Uint8Array): Promise<void>;
  writeData(frame: Uint8Array): Promise<void>;
  readStatus(): Promise<DataView>;
  onStatus(listener: RemoteInputStatusListener): void;
  offStatus(listener: RemoteInputStatusListener): void;
  onDisconnect(listener: RemoteInputDisconnectListener): void;
  offDisconnect(listener: RemoteInputDisconnectListener): void;
  disconnect(): Promise<void>;
}
