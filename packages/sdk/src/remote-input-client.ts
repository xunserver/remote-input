import {
  maxInputBytes,
  type MessageTransport,
  type NotificationMessage,
  type OperationStatus,
  type ProtocolSessionEvent,
} from "@remote-copy/protocol";
import {
  createOperationId,
  ProtocolResponseError,
  ProtocolSession,
  ProtocolValidationError,
  SocketIoClientTransport,
} from "@remote-copy/protocol/implementations";
import { SendInputError } from "./send-input-error.js";
import type {
  InputSubmission,
  OperationStatusListener,
  ProtocolNotificationListener,
  RemoteInputClientOptions,
  RemoteInputError,
  RemoteInputState,
  RemoteInputStateListener,
} from "./types.js";

const initialState: RemoteInputState = {
  connectionState: "idle",
  transportKind: null,
  peer: null,
  capabilities: null,
  peers: [],
  currentOperation: null,
  isSubmitting: false,
  error: null,
};

type NormalizedOptions = RemoteInputClientOptions & {
  clientName: string;
  requestTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
};

export class RemoteInputClient {
  private readonly listeners = new Set<RemoteInputStateListener>();
  private readonly notificationListeners = new Set<ProtocolNotificationListener>();
  private readonly operationListeners = new Map<string, Set<OperationStatusListener>>();
  private readonly operations = new Map<string, OperationStatus>();
  private readonly syntheticOperations = new Set<string>();
  private readonly options: NormalizedOptions;
  private state = initialState;
  private session: ProtocolSession | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private connectionGeneration = 0;

  constructor(options: RemoteInputClientOptions = {}) {
    this.options = {
      ...options,
      clientName: options.clientName ?? "Client",
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 10_000,
    };
  }

  getState(): RemoteInputState {
    return this.state;
  }

  getOperationStatus(operationId: string): OperationStatus | null {
    return this.operations.get(operationId) ?? null;
  }

  subscribe(listener: RemoteInputStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeNotification(listener: ProtocolNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  subscribeOperation(operationId: string, listener: OperationStatusListener): () => void {
    const listeners = this.operationListeners.get(operationId) ?? new Set<OperationStatusListener>();
    listeners.add(listener);
    this.operationListeners.set(operationId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.operationListeners.delete(operationId);
    };
  }

  async connect(url: string): Promise<void> {
    const generation = ++this.connectionGeneration;
    await this.releaseSession();
    if (generation !== this.connectionGeneration) return;

    const transport = this.createTransport(url);
    const session = new ProtocolSession(transport, {
      createRequestId: this.options.createRequestId,
      requestTimeoutMs: this.options.requestTimeoutMs,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.options.heartbeatTimeoutMs,
    });
    this.session = session;
    this.unsubscribeSession = session.subscribe((event) => this.handleSessionEvent(session, event));
    this.operations.clear();
    this.syntheticOperations.clear();
    this.updateState({
      ...initialState,
      connectionState: "connecting",
      transportKind: transport.kind,
    });

    try {
      await session.connect();
      const info = await session.request("session.open", { clientName: this.options.clientName });
      if (this.session !== session) return;
      session.startHeartbeat();
      this.updateState({
        ...this.state,
        connectionState: "ready",
        peer: info.peer,
        capabilities: info.capabilities,
        error: null,
      });
    } catch (error) {
      if (this.session === session) {
        await this.releaseSession();
        this.setConnectionError("transport-connect-failed", error);
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    ++this.connectionGeneration;
    await this.releaseSession();
    this.updateState({
      ...this.state,
      connectionState: "disconnected",
      peer: null,
      capabilities: null,
      peers: [],
      isSubmitting: false,
      error: null,
    });
  }

  async sendInput(text: string): Promise<InputSubmission> {
    const session = this.session;
    if (!text.trim()) {
      throw new SendInputError("input-empty", "Input text cannot be empty.");
    }
    if (new TextEncoder().encode(text).byteLength > maxInputBytes) {
      throw new SendInputError("input-too-large", `Input text exceeds ${maxInputBytes} UTF-8 bytes.`);
    }
    if (this.state.connectionState !== "ready" || !session) {
      throw new SendInputError("transport-not-ready", "The protocol session is not ready.");
    }
    if (!this.state.capabilities?.methods.includes("input.submit")) {
      throw new SendInputError("input-unsupported", "The downstream peer does not support input.submit.");
    }
    if (this.state.isSubmitting || isOperationActive(this.state.currentOperation)) {
      throw new SendInputError("input-busy", "Another input operation is still active.");
    }

    const operationId = (this.options.createOperationId ?? createOperationId)();
    if (!operationId) {
      throw new SendInputError("request-failed", "Operation ID must not be empty.");
    }
    this.updateState({ ...this.state, isSubmitting: true, error: null });

    try {
      const result = await session.request("input.submit", { operationId, text });
      if (result.operationId !== operationId) {
        throw new Error("The downstream peer returned a different operation ID.");
      }
      if (!this.operations.has(operationId)) {
        this.applyOperationStatus({
          operationId,
          revision: 0,
          state: "accepted",
          stage: "accepted",
          progress: 0,
          message: "下游已接受输入请求。",
        }, true);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Input request failed.";
      if (this.session === session) {
        this.updateState({
          ...this.state,
          error: {
            code: error instanceof ProtocolResponseError ? "peer-error" : "transport-error",
            message,
          },
        });
      }
      throw new SendInputError("request-failed", message, { cause: error });
    } finally {
      if (this.session === session) {
        this.updateState({ ...this.state, isSubmitting: false });
      }
    }
  }

  async refreshOperationStatus(operationId: string): Promise<OperationStatus> {
    const session = this.session;
    if (this.state.connectionState !== "ready" || !session) {
      throw new Error("The protocol session is not ready.");
    }
    if (!this.state.capabilities?.methods.includes("operation.get")) {
      throw new Error("The downstream peer does not support operation.get.");
    }
    const status = await session.request("operation.get", { operationId });
    return this.applyOperationStatus(status);
  }

  private createTransport(url: string): MessageTransport {
    return this.options.createTransport?.(url) ?? new SocketIoClientTransport(url);
  }

  private async releaseSession(): Promise<void> {
    const session = this.session;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.session = null;
    if (session) await session.disconnect();
  }

  private handleSessionEvent(session: ProtocolSession, event: ProtocolSessionEvent): void {
    if (this.session !== session) return;
    if (event.type === "transport-state") {
      if (event.state === "connected" && this.state.connectionState === "connecting") {
        this.updateState({ ...this.state, connectionState: "connected" });
      } else if (event.state === "disconnected" || event.state === "error") {
        this.updateState({
          ...this.state,
          connectionState: event.state,
          peer: null,
          capabilities: null,
          peers: [],
          isSubmitting: false,
        });
      }
      return;
    }
    if (event.type === "error") {
      this.updateState({
        ...this.state,
        error: {
          code: event.error instanceof ProtocolValidationError ? "invalid-message" : "transport-error",
          message: event.error instanceof Error ? event.error.message : undefined,
        },
      });
      return;
    }
    this.handleNotification(event.notification);
  }

  private handleNotification(notification: NotificationMessage): void {
    for (const listener of this.notificationListeners) listener(notification);
    if (notification.name === "operation.status") {
      this.applyOperationStatus(notification.body);
    } else {
      this.updateState({ ...this.state, peers: notification.body.peers });
    }
  }

  private applyOperationStatus(status: OperationStatus, synthetic = false): OperationStatus {
    const existing = this.operations.get(status.operationId);
    const replacesSynthetic = existing
      && existing.revision === status.revision
      && this.syntheticOperations.has(status.operationId)
      && !synthetic;
    if (existing && existing.revision >= status.revision && !replacesSynthetic) return existing;

    this.operations.set(status.operationId, status);
    if (synthetic) this.syntheticOperations.add(status.operationId);
    else this.syntheticOperations.delete(status.operationId);
    this.updateState({ ...this.state, currentOperation: status });
    for (const listener of this.operationListeners.get(status.operationId) ?? []) listener(status);
    return status;
  }

  private setConnectionError(code: RemoteInputError["code"], error: unknown): void {
    this.updateState({
      ...this.state,
      connectionState: "error",
      isSubmitting: false,
      error: { code, message: error instanceof Error ? error.message : undefined },
    });
  }

  private updateState(state: RemoteInputState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function isOperationActive(status: OperationStatus | null): boolean {
  return status?.state === "accepted" || status?.state === "processing";
}
