import { ProtocolValidationError, type OperationStatus } from "@remote-copy/shared";
import { ProtocolResponseError, ProtocolSession, type ProtocolSessionEvent } from "./protocol/protocol-session.js";
import { createDefaultRequestId } from "./protocol/request-id.js";
import { SendInputError } from "./send-input-error.js";
import type { DuplexTransport } from "./transports/transport.js";
import type {
  InputSubmission,
  OperationStatusListener,
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

export class RemoteInputClient {
  private readonly listeners = new Set<RemoteInputStateListener>();
  private readonly operationListeners = new Map<string, Set<OperationStatusListener>>();
  private readonly operations = new Map<string, OperationStatus>();
  private readonly syntheticOperations = new Set<string>();
  private readonly clientName: string;
  private readonly createRequestId: () => string;
  private readonly requestTimeoutMs: number;
  private state = initialState;
  private session: ProtocolSession | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private connectionGeneration = 0;

  constructor(options: RemoteInputClientOptions = {}) {
    this.clientName = options.clientName ?? "Client";
    this.createRequestId = options.createRequestId ?? createDefaultRequestId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
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

  subscribeOperation(operationId: string, listener: OperationStatusListener): () => void {
    const listeners = this.operationListeners.get(operationId) ?? new Set<OperationStatusListener>();
    listeners.add(listener);
    this.operationListeners.set(operationId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.operationListeners.delete(operationId);
      }
    };
  }

  async connect(transport: DuplexTransport): Promise<void> {
    const generation = ++this.connectionGeneration;
    await this.releaseSession();

    if (generation !== this.connectionGeneration) {
      return;
    }

    const session = new ProtocolSession(transport, {
      createRequestId: this.createRequestId,
      requestTimeoutMs: this.requestTimeoutMs,
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
      const info = await session.connect(this.clientName);
      if (this.session !== session) {
        return;
      }

      this.updateState({
        ...this.state,
        connectionState: "ready",
        peer: info.peer,
        capabilities: info.capabilities,
        error: null,
      });
    } catch (error) {
      if (this.session === session) {
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

    if (this.state.connectionState !== "ready" || !session) {
      throw new SendInputError("transport-not-ready", "The protocol session is not ready.");
    }

    if (!this.state.capabilities?.methods.includes("input.submit")) {
      throw new SendInputError("input-unsupported", "The downstream peer does not support input.submit.");
    }

    if (this.state.isSubmitting || isOperationActive(this.state.currentOperation)) {
      throw new SendInputError("input-busy", "Another input operation is still active.");
    }

    this.updateState({
      ...this.state,
      isSubmitting: true,
      error: null,
    });

    try {
      const result = await session.request("input.submit", { text });
      const existing = this.operations.get(result.operationId);

      if (!existing) {
        this.applyOperationStatus({
          operationId: result.operationId,
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
        this.updateState({
          ...this.state,
          isSubmitting: false,
        });
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

  private async releaseSession(): Promise<void> {
    const session = this.session;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.session = null;

    if (session) {
      await session.disconnect();
    }
  }

  private handleSessionEvent(session: ProtocolSession, event: ProtocolSessionEvent): void {
    if (this.session !== session) {
      return;
    }

    if (event.type === "transport-state") {
      if (event.state === "connected" && this.state.connectionState === "connecting") {
        this.updateState({ ...this.state, connectionState: "connected" });
      } else if (event.state === "disconnected") {
        this.updateState({
          ...this.state,
          connectionState: "disconnected",
          peer: null,
          capabilities: null,
          peers: [],
          isSubmitting: false,
        });
      } else if (event.state === "error") {
        this.updateState({
          ...this.state,
          connectionState: "error",
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

    if (event.event.name === "operation.status") {
      this.applyOperationStatus(event.event.body);
      return;
    }

    this.updateState({
      ...this.state,
      peers: event.event.body.peers,
    });
  }

  private applyOperationStatus(status: OperationStatus, synthetic = false): OperationStatus {
    const existing = this.operations.get(status.operationId);
    const replacesSynthetic = existing
      && existing.revision === status.revision
      && this.syntheticOperations.has(status.operationId)
      && !synthetic;
    if (existing && existing.revision >= status.revision && !replacesSynthetic) {
      return existing;
    }

    this.operations.set(status.operationId, status);
    if (synthetic) {
      this.syntheticOperations.add(status.operationId);
    } else {
      this.syntheticOperations.delete(status.operationId);
    }
    this.updateState({
      ...this.state,
      currentOperation: status,
    });

    for (const listener of this.operationListeners.get(status.operationId) ?? []) {
      listener(status);
    }

    return status;
  }

  private setConnectionError(code: RemoteInputError["code"], error: unknown): void {
    this.updateState({
      ...this.state,
      connectionState: "error",
      isSubmitting: false,
      error: {
        code,
        message: error instanceof Error ? error.message : undefined,
      },
    });
  }

  private updateState(state: RemoteInputState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function isOperationActive(status: OperationStatus | null): boolean {
  return status?.state === "accepted" || status?.state === "processing";
}
