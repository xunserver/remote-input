import {
  parseResultBody,
  protocolVersion,
  type EventMessage,
  type ProtocolError,
  type ProtocolEventMap,
  type ProtocolEventName,
  type ProtocolMessage,
  type ProtocolMethod,
  type ProtocolRequestMap,
  type ProtocolResultMap,
  type RequestMessage,
  type SessionOpenResult,
} from "@remote-copy/shared";
import type { DuplexTransport, TransportEvent, TransportState } from "../transports/transport.js";
import { JsonProtocolCodec, type ProtocolCodec } from "./json-protocol-codec.js";
import { createDefaultRequestId } from "./request-id.js";

export class ProtocolResponseError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = "ProtocolResponseError";
  }
}

export type ProtocolSessionEvent =
  | { type: "transport-state"; state: TransportState }
  | { type: "event"; event: EventMessage }
  | { type: "error"; error: unknown };

export type ProtocolSessionListener = (event: ProtocolSessionEvent) => void;

export type ProtocolSessionOptions = {
  codec?: ProtocolCodec;
  createRequestId?: () => string;
  requestTimeoutMs?: number;
};

type PendingRequest = {
  method: ProtocolMethod;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ProtocolSession {
  private readonly listeners = new Set<ProtocolSessionListener>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly codec: ProtocolCodec;
  private readonly createRequestId: () => string;
  private readonly requestTimeoutMs: number;
  private unsubscribeTransport: (() => void) | null = null;
  private sessionInfo: SessionOpenResult | null = null;

  constructor(
    readonly transport: DuplexTransport,
    options: ProtocolSessionOptions = {},
  ) {
    this.codec = options.codec ?? new JsonProtocolCodec();
    this.createRequestId = options.createRequestId ?? createDefaultRequestId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  get info(): SessionOpenResult | null {
    return this.sessionInfo;
  }

  async connect(clientName: string): Promise<SessionOpenResult> {
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = this.transport.subscribe((event) => this.handleTransportEvent(event));

    try {
      await this.transport.connect();
      this.sessionInfo = await this.request("session.open", { clientName });
      return this.sessionInfo;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.rejectPending(new Error("Protocol session disconnected."));
    this.sessionInfo = null;
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    await this.transport.disconnect();
  }

  async request<M extends ProtocolMethod>(
    method: M,
    body: ProtocolRequestMap[M],
  ): Promise<ProtocolResultMap[M]> {
    if (this.transport.state !== "connected") {
      throw new Error("Protocol transport is not connected.");
    }

    const id = this.createRequestId();
    const message: RequestMessage<M> = {
      v: protocolVersion,
      kind: "request",
      id,
      method,
      body,
    } as RequestMessage<M>;

    const response = new Promise<ProtocolResultMap[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Protocol request timed out: ${method}.`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        method,
        resolve: (value) => resolve(value as ProtocolResultMap[M]),
        reject,
        timer,
      });
    });

    try {
      await this.transport.send(this.codec.encode(message));
    } catch (error) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        pending.reject(error);
      }
    }

    return response;
  }

  subscribe(listener: ProtocolSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleTransportEvent(event: TransportEvent): void {
    if (event.type === "state") {
      if (event.state === "disconnected" || event.state === "error") {
        this.sessionInfo = null;
        this.rejectPending(new Error(`Protocol transport entered ${event.state} state.`));
      }
      this.emit({ type: "transport-state", state: event.state });
      return;
    }

    if (event.type === "error") {
      this.emit({ type: "error", error: event.error });
      return;
    }

    try {
      this.handleMessage(this.codec.decode(event.message));
    } catch (error) {
      this.emit({ type: "error", error });
    }
  }

  private handleMessage(message: ProtocolMessage): void {
    if (message.kind === "response") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.id);

      if (!message.ok) {
        pending.reject(new ProtocolResponseError(message.error));
        return;
      }

      try {
        pending.resolve(parseResultBody(pending.method, message.body));
      } catch (error) {
        pending.reject(error);
      }
      return;
    }

    if (message.kind === "event") {
      this.emit({ type: "event", event: message });
      return;
    }

    this.emit({ type: "error", error: new Error("The downstream peer sent an unsupported request.") });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private emit(event: ProtocolSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export type ProtocolEventBody<N extends ProtocolEventName> = ProtocolEventMap[N];
