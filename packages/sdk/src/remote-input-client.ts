import type { ClientMessage, ServerMessage } from "@remote-copy/shared";
import type { InputTransport, TransportEvent } from "./transports/transport.js";
import type {
  RemoteInputClientOptions,
  RemoteInputError,
  RemoteInputState,
  RemoteInputStateListener,
} from "./types.js";

const initialState: RemoteInputState = {
  connectionState: "idle",
  clientId: "",
  deviceName: "",
  serverInfo: null,
  clientCount: 0,
  devices: [],
  currentStatus: null,
  error: null,
};

export class RemoteInputClient {
  private readonly listeners = new Set<RemoteInputStateListener>();
  private readonly deviceName: string;
  private readonly createRequestId: () => string;
  private state: RemoteInputState = initialState;
  private transport: InputTransport | null = null;
  private unsubscribeTransport: (() => void) | null = null;

  constructor(options: RemoteInputClientOptions = {}) {
    this.deviceName = options.deviceName ?? "Client";
    this.createRequestId = options.createRequestId ?? (() => globalThis.crypto.randomUUID());
  }

  getState(): RemoteInputState {
    return this.state;
  }

  subscribe(listener: RemoteInputStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(transport: InputTransport): void {
    this.releaseTransport();
    this.transport = transport;
    this.unsubscribeTransport = transport.subscribe((event) => this.handleTransportEvent(event));
    this.updateState({
      ...initialState,
      connectionState: "connecting",
    });

    try {
      transport.connect();
    } catch (error) {
      this.setConnectionError("transport-connect-failed", error);
    }
  }

  disconnect(): void {
    this.releaseTransport();
    this.updateState({
      ...this.state,
      connectionState: "disconnected",
    });
  }

  sendInput(text: string): string | null {
    const transport = this.transport;

    if (
      !text.trim() ||
      this.state.connectionState !== "ready" ||
      !transport?.isOpen ||
      isInputBusy(this.state.currentStatus?.status)
    ) {
      return null;
    }

    const requestId = this.createRequestId();
    const message: ClientMessage = { type: "input", requestId, text };

    try {
      transport.send(JSON.stringify(message));
      this.updateState({
        ...this.state,
        currentStatus: {
          type: "input-status",
          requestId,
          status: "queued",
          progress: 5,
          message: "",
        },
        error: null,
      });
      return requestId;
    } catch (error) {
      this.updateState({
        ...this.state,
        error: createError("transport-send-failed", error),
      });
      return null;
    }
  }

  private releaseTransport(): void {
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    this.transport?.disconnect();
    this.transport = null;
  }

  private handleTransportEvent(event: TransportEvent): void {
    if (event.type === "open") {
      this.handleOpen();
      return;
    }

    if (event.type === "message") {
      this.handleMessage(event.data);
      return;
    }

    if (event.type === "error") {
      this.setConnectionError("transport-error", event.error);
      return;
    }

    this.updateState({
      ...this.state,
      connectionState: this.state.connectionState === "error" ? "error" : "disconnected",
    });
  }

  private handleOpen(): void {
    const transport = this.transport;
    if (!transport) {
      return;
    }

    this.updateState({
      ...this.state,
      connectionState: "connected",
      error: null,
    });

    const hello: ClientMessage = {
      type: "hello",
      deviceName: this.deviceName,
    };

    try {
      transport.send(JSON.stringify(hello));
    } catch (error) {
      this.setConnectionError("transport-send-failed", error);
    }
  }

  private handleMessage(data: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      this.setProtocolError(error);
      return;
    }

    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      this.setProtocolError();
      return;
    }

    const message = parsed as ServerMessage;

    if (message.type === "connected") {
      this.updateState({
        ...this.state,
        connectionState: "connected",
        clientId: message.clientId,
        serverInfo: message.server,
      });
      return;
    }

    if (message.type === "ready") {
      this.updateState({
        ...this.state,
        connectionState: "ready",
        clientId: message.clientId,
        deviceName: message.deviceName,
        serverInfo: message.server,
      });
      return;
    }

    if (message.type === "clients") {
      this.updateState({
        ...this.state,
        clientCount: message.count,
        devices: message.devices,
      });
      return;
    }

    if (message.type === "input-status") {
      this.updateState({
        ...this.state,
        currentStatus: message,
      });
      return;
    }

    if (message.type === "error") {
      this.updateState({
        ...this.state,
        error: {
          code: "server-error",
          message: message.message,
        },
      });
      return;
    }

    this.setProtocolError();
  }

  private setProtocolError(error?: unknown): void {
    this.updateState({
      ...this.state,
      error: createError("invalid-message", error),
    });
  }

  private setConnectionError(code: RemoteInputError["code"], error: unknown): void {
    this.updateState({
      ...this.state,
      connectionState: "error",
      error: createError(code, error),
    });
  }

  private updateState(state: RemoteInputState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function isInputBusy(status: string | undefined): boolean {
  return status === "queued" || status === "copying" || status === "pasting";
}

function createError(code: RemoteInputError["code"], error: unknown): RemoteInputError {
  return {
    code,
    message: error instanceof Error ? error.message : undefined,
  };
}
