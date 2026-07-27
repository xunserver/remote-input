export type HidConnectionState = "waiting" | "connected" | "disconnected";

export type RuntimeStatus = {
  hid: {
    state: HidConnectionState;
    deviceName: string;
  };
  websocketClients: number;
};

type RuntimeStatusListener = (status: RuntimeStatus) => void;

export class RuntimeStatusStore {
  private status: RuntimeStatus = {
    hid: { state: "waiting", deviceName: "" },
    websocketClients: 0,
  };
  private readonly listeners = new Set<RuntimeStatusListener>();

  snapshot(): RuntimeStatus {
    return {
      hid: { ...this.status.hid },
      websocketClients: this.status.websocketClients,
    };
  }

  setHid(state: HidConnectionState, deviceName = ""): void {
    if (
      this.status.hid.state === state
      && this.status.hid.deviceName === deviceName
    ) return;
    this.status = {
      ...this.status,
      hid: { state, deviceName },
    };
    this.emit();
  }

  setWebSocketClients(websocketClients: number): void {
    if (this.status.websocketClients === websocketClients) return;
    this.status = { ...this.status, websocketClients };
    this.emit();
  }

  subscribe(listener: RuntimeStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}
