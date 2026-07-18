import type { ProtocolClock, TimeoutHandle } from "./clock.js";
import { systemClock } from "./clock.js";
import {
  ACK_TIMEOUT_MS,
  CLOSE_ACK_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  MAX_QUEUED_BYTES,
  MAX_QUEUED_MESSAGES,
  MAX_SEND_ATTEMPTS,
} from "./constants.js";
import {
  SDKError,
  sdkErrorCodes,
  type DeliveryState,
} from "./errors.js";
import { isJsonValue, snapshotJsonValue, type JsonValue } from "./json.js";
import { isPositiveSafeInteger, isSessionMessage, type SessionMessage } from "./messages.js";
import type {
  ProtocolRuntimeOptions,
  Transport,
  TransportReceiver,
  TransportSendOptions,
  TransportState,
} from "./transport.js";

const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type SocketEventListener = (event: any) => void;

/**
 * The EventTarget-shaped subset shared by browser WebSocket and the `ws`
 * package. V1 deliberately accepts text frames only.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: SocketEventListener,
  ): void;
  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: SocketEventListener,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WebSocketTransportOptions extends ProtocolRuntimeOptions {
  socketFactory?: WebSocketFactory;
}

export type TransportStateListener = (state: TransportState) => void;

type DataFrame = {
  kind: "DATA";
  transferId: number;
  chunkIndex: 0;
  chunkCount: 1;
  payload: string;
};

type AckFrame = {
  kind: "ACK";
  transferId: number;
  chunkIndex: 0;
};

type CloseFrame = { kind: "CLOSE" };
type CloseAckFrame = { kind: "CLOSE_ACK" };
type TransportFrame = DataFrame | AckFrame | CloseFrame | CloseAckFrame;

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  readonly settled: boolean;
};

type SocketBinding = {
  socket: WebSocketLike;
  generation: number;
  onOpen: SocketEventListener;
  onMessage: SocketEventListener;
  onClose: SocketEventListener;
  onError: SocketEventListener;
};

type SendItem = {
  readonly transferId: number;
  readonly generation: number;
  readonly snapshot: string;
  readonly byteLength: number;
  readonly options: NormalizedSendOptions;
  readonly deferred: Deferred<void>;
  attempts: number;
  delivery: DeliveryState;
  settled: boolean;
  sending: boolean;
  ackReceivedWhileSending: boolean;
  ackTimer: TimeoutHandle | undefined;
  deadlineTimer: TimeoutHandle | undefined;
  abortListener: (() => void) | undefined;
};

type NormalizedSendOptions = {
  readonly signal: AbortSignal | undefined;
  readonly deadlineAt: number | undefined;
  readonly onDeliveryChange:
    | ((delivery: Exclude<DeliveryState, "not_sent">) => void)
    | undefined;
};

/** Internal-only result used when a Session aborts work after another terminal event won. */
export class TransportSendCancelledError extends Error {
  readonly delivery: DeliveryState;

  constructor(delivery: DeliveryState) {
    super("Transport send was cancelled by its owning Session.");
    this.name = "TransportSendCancelledError";
    this.delivery = delivery;
  }
}

export class WebSocketTransport implements Transport {
  private readonly url: string;
  private readonly socketFactory: WebSocketFactory | undefined;
  private readonly clock: ProtocolClock;
  private readonly onDiagnostic: ProtocolRuntimeOptions["onDiagnostic"];
  private readonly stateListeners = new Set<TransportStateListener>();
  private readonly encoder = new TextEncoder();

  private stateValue: TransportState = "idle";
  private receiver: TransportReceiver | undefined;
  private binding: SocketBinding | undefined;
  private connectDeferred: Deferred<void> | undefined;
  private closeDeferred: Deferred<void> | undefined;
  private closeTimer: TimeoutHandle | undefined;
  private generationCounter = 0;
  private currentGeneration = 0;
  private nextTransferId = 1;
  private highestAcceptedTransferId = 0;
  private highestAcceptedDigest: string | undefined;
  private queue: SendItem[] = [];
  private active: SendItem | undefined;
  private queuedBytes = 0;
  private pumpScheduled = false;
  private pumpToken = 0;
  private peerCloseInProgressGeneration = 0;
  private hasUrlSource = true;

  constructor(url: string, options: WebSocketTransportOptions = {}) {
    this.url = url;
    this.socketFactory = options.socketFactory;
    this.clock = options.clock ?? systemClock;
    this.onDiagnostic = options.onDiagnostic;
  }

  /**
   * Adopt an accepted server-side socket. An already-open socket becomes
   * connected synchronously; a connecting socket can be awaited through
   * `connect()` or a later direct `attach()` call.
   */
  static fromSocket(
    socket: WebSocketLike,
    options: WebSocketTransportOptions = {},
  ): WebSocketTransport {
    const transport = new WebSocketTransport("", options);
    transport.hasUrlSource = false;
    void transport.attach(socket).catch((cause: unknown) => {
      transport.diagnostic("Failed to attach accepted WebSocket.", cause);
    });
    return transport;
  }

  get state(): TransportState {
    return this.stateValue;
  }

  subscribe(listener: TransportStateListener): () => void {
    this.stateListeners.add(listener);
    try {
      listener(this.stateValue);
    } catch (cause) {
      this.diagnostic("Transport state listener threw.", cause);
    }
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  bind(receiver: TransportReceiver): void {
    if (this.receiver === receiver) {
      return;
    }
    if (this.receiver !== undefined) {
      throw new Error("WebSocketTransport already has a bound receiver.");
    }
    if (this.stateValue === "closing") {
      throw new Error("Cannot bind a receiver while WebSocketTransport is closing.");
    }
    this.receiver = receiver;
  }

  unbind(receiver: TransportReceiver): void {
    if (this.receiver === receiver) {
      this.receiver = undefined;
    }
  }

  connect(): Promise<void> {
    if (this.stateValue === "connected") {
      return Promise.resolve();
    }
    if (this.stateValue === "connecting" && this.connectDeferred !== undefined) {
      return this.connectDeferred.promise;
    }
    if (this.stateValue === "closing") {
      return Promise.reject(this.notConnectedError("Transport is closing."));
    }
    if (!this.hasUrlSource) {
      return Promise.reject(
        this.notConnectedError(
          "This accepted-socket transport must be reconnected with attach().",
        ),
      );
    }

    let socket: WebSocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch (cause) {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.transportNotConnected,
          "Failed to create WebSocket.",
          "not_sent",
          { cause },
        ),
      );
    }
    return this.attach(socket);
  }

  attach(socket: WebSocketLike): Promise<void> {
    if (this.binding?.socket === socket) {
      if (this.stateValue === "connected") {
        return Promise.resolve();
      }
      if (this.stateValue === "connecting" && this.connectDeferred !== undefined) {
        return this.connectDeferred.promise;
      }
    }
    if (
      this.stateValue === "connecting" ||
      this.stateValue === "connected" ||
      this.stateValue === "closing"
    ) {
      return Promise.reject(
        this.notConnectedError("Transport already owns an active WebSocket."),
      );
    }
    if (
      socket.readyState !== WEBSOCKET_CONNECTING &&
      socket.readyState !== WEBSOCKET_OPEN
    ) {
      return Promise.reject(
        this.notConnectedError("Cannot attach a closing or closed WebSocket."),
      );
    }

    this.resetConnectionLocalState();
    const generation = ++this.generationCounter;
    this.currentGeneration = generation;
    const deferred = createDeferred<void>();
    this.connectDeferred = deferred;

    const binding: SocketBinding = {
      socket,
      generation,
      onOpen: () => this.handleOpen(generation),
      onMessage: (event) => this.handleMessage(generation, event),
      onClose: (event) => this.handleSocketClose(generation, event),
      onError: (event) => this.handleSocketError(generation, event),
    };
    this.binding = binding;

    try {
      socket.addEventListener("open", binding.onOpen);
      socket.addEventListener("message", binding.onMessage);
      socket.addEventListener("close", binding.onClose);
      socket.addEventListener("error", binding.onError);
    } catch (cause) {
      this.invalidateBinding(generation);
      this.connectDeferred = undefined;
      this.resetConnectionLocalState();
      deferred.reject(
        new SDKError(
          sdkErrorCodes.transportNotConnected,
          "Failed to install WebSocket event listeners.",
          "not_sent",
          { cause },
        ),
      );
      return deferred.promise;
    }

    if (
      this.currentGeneration !== generation ||
      this.binding !== binding ||
      (socket.readyState !== WEBSOCKET_CONNECTING &&
        socket.readyState !== WEBSOCKET_OPEN)
    ) {
      if (this.currentGeneration === generation) {
        this.handleUnexpectedDisconnect(generation, undefined);
      }
      return deferred.promise;
    }

    this.setState("connecting");
    if (socket.readyState === WEBSOCKET_OPEN) {
      this.handleOpen(generation);
    }
    return deferred.promise;
  }

  send(
    message: SessionMessage,
    options: TransportSendOptions = {},
  ): Promise<void> {
    let sendOptions: NormalizedSendOptions;
    try {
      sendOptions = {
        signal: options.signal,
        deadlineAt: options.deadlineAt,
        onDeliveryChange: options.onDeliveryChange,
      };
    } catch (cause) {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.encodeError,
          "Transport send options could not be read safely.",
          "not_sent",
          { cause },
        ),
      );
    }
    const generation = this.currentGeneration;
    const socket = this.binding?.socket;
    if (
      this.stateValue !== "connected" ||
      generation === 0 ||
      socket === undefined ||
      socket.readyState !== WEBSOCKET_OPEN
    ) {
      return Promise.reject(this.notConnectedError("Transport is not connected."));
    }
    if (isSignalAborted(sendOptions.signal)) {
      return Promise.reject(new TransportSendCancelledError("not_sent"));
    }
    if (this.isDeadlineReached(sendOptions.deadlineAt)) {
      return Promise.reject(this.deadlineError("not_sent"));
    }

    const transferId = this.allocateTransferId();
    if (transferId === undefined) {
      return Promise.reject(
        this.notConnectedError(
          "Connection transfer ID space is exhausted; reconnect before sending again.",
        ),
      );
    }

    let snapshot: string;
    let byteLength: number;
    try {
      const messageSnapshot = snapshotJsonValue(message);
      if (messageSnapshot === undefined || !isSessionMessage(messageSnapshot)) {
        throw new TypeError("Message is not a descriptor-safe SessionMessage.");
      }
      const payload = JSON.stringify(messageSnapshot);
      const frame: DataFrame = {
        kind: "DATA",
        transferId,
        chunkIndex: 0,
        chunkCount: 1,
        payload,
      };
      snapshot = JSON.stringify(frame);
      byteLength = this.encoder.encode(snapshot).byteLength;
    } catch (cause) {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.encodeError,
          "Session message could not be encoded safely.",
          "not_sent",
          { cause },
        ),
      );
    }

    if (
      this.stateValue !== "connected" ||
      this.currentGeneration !== generation ||
      this.binding?.socket !== socket ||
      socket.readyState !== WEBSOCKET_OPEN
    ) {
      return Promise.reject(
        this.notConnectedError("Transport changed connection while encoding DATA."),
      );
    }
    if (isSignalAborted(sendOptions.signal)) {
      return Promise.reject(new TransportSendCancelledError("not_sent"));
    }
    if (this.isDeadlineReached(sendOptions.deadlineAt)) {
      return Promise.reject(this.deadlineError("not_sent"));
    }
    if (byteLength > MAX_MESSAGE_BYTES) {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.messageTooLarge,
          `Encoded DATA frame exceeds ${MAX_MESSAGE_BYTES} bytes.`,
          "not_sent",
        ),
      );
    }
    if (
      this.queue.length >= MAX_QUEUED_MESSAGES ||
      this.queuedBytes + byteLength > MAX_QUEUED_BYTES
    ) {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.transportQueueFull,
          "Transport DATA queue is full.",
          "not_sent",
        ),
      );
    }

    const deferred = createDeferred<void>();
    const item: SendItem = {
      transferId,
      generation,
      snapshot,
      byteLength,
      options: sendOptions,
      deferred,
      attempts: 0,
      delivery: "not_sent",
      settled: false,
      sending: false,
      ackReceivedWhileSending: false,
      ackTimer: undefined,
      deadlineTimer: undefined,
      abortListener: undefined,
    };
    this.queue.push(item);
    this.queuedBytes += byteLength;
    this.installCancellation(item);
    if (!item.settled) {
      this.schedulePump();
    }
    return deferred.promise;
  }

  close(): Promise<void> {
    if (this.stateValue === "closing" && this.closeDeferred !== undefined) {
      return this.closeDeferred.promise;
    }
    if (
      this.stateValue === "closed" &&
      this.binding === undefined &&
      this.receiver === undefined
    ) {
      return Promise.resolve();
    }

    const deferred = createDeferred<void>();
    this.closeDeferred = deferred;

    if (
      this.stateValue === "idle" ||
      this.stateValue === "closed" ||
      this.binding === undefined
    ) {
      this.stateValue = "closed";
      this.rejectAllForClose();
      this.resetConnectionLocalState();
      const receiver = this.takeReceiver();
      this.closeDeferred = undefined;
      deferred.resolve();
      this.notifyLocalClosed(receiver);
      if (this.stateValue === "closed" && this.currentGeneration === 0) {
        this.emitState("closed");
      }
      return deferred.promise;
    }

    const generation = this.binding.generation;
    this.stateValue = "closing";
    this.rejectAllForClose();
    this.notifyLocalClosed(this.takeReceiver());

    if (
      this.stateValue !== "closing" ||
      this.currentGeneration !== generation ||
      this.binding?.generation !== generation
    ) {
      return deferred.promise;
    }
    if (this.binding.socket.readyState !== WEBSOCKET_OPEN) {
      this.finishLocalClose(generation);
      return deferred.promise;
    }

    try {
      this.closeTimer = this.clock.setTimeout(() => {
        if (this.currentGeneration === generation && this.stateValue === "closing") {
          this.diagnostic("Timed out waiting for CLOSE_ACK.");
          this.finishLocalClose(generation);
        }
      }, CLOSE_ACK_TIMEOUT_MS);
    } catch (cause) {
      this.diagnostic("Failed to schedule CLOSE_ACK timer.", cause);
      this.finishLocalClose(generation);
      return deferred.promise;
    }

    if (!this.sendControl({ kind: "CLOSE" }, generation)) {
      this.finishLocalClose(generation);
      return deferred.promise;
    }
    if (
      this.stateValue === "closing" &&
      this.currentGeneration === generation
    ) {
      this.emitState("closing");
    }
    return deferred.promise;
  }

  private createSocket(url: string): WebSocketLike {
    if (this.socketFactory !== undefined) {
      return this.socketFactory(url);
    }
    const SocketConstructor = globalThis.WebSocket;
    if (SocketConstructor === undefined) {
      throw new Error("No global WebSocket constructor is available.");
    }
    return new SocketConstructor(url);
  }

  private handleOpen(generation: number): void {
    if (
      generation !== this.currentGeneration ||
      this.binding?.generation !== generation ||
      this.stateValue !== "connecting"
    ) {
      return;
    }
    const deferred = this.connectDeferred;
    this.connectDeferred = undefined;
    this.stateValue = "connected";
    deferred?.resolve();
    this.emitState("connected");
    if (
      this.stateValue === "connected" &&
      this.currentGeneration === generation
    ) {
      this.schedulePump();
    }
  }

  private handleMessage(generation: number, event: unknown): void {
    if (
      generation !== this.currentGeneration ||
      this.binding?.generation !== generation ||
      (this.stateValue !== "connected" && this.stateValue !== "closing")
    ) {
      return;
    }

    const raw = getMessageData(event);
    if (typeof raw !== "string") {
      this.diagnostic("Dropped non-text WebSocket frame.");
      return;
    }
    if (this.encoder.encode(raw).byteLength > MAX_MESSAGE_BYTES) {
      this.diagnostic("Dropped oversized inbound WebSocket frame.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      this.diagnostic("Dropped malformed Transport frame.", cause);
      return;
    }
    const frame = parseTransportFrame(parsed);
    if (frame === undefined) {
      this.diagnostic("Dropped invalid Transport frame.");
      return;
    }

    switch (frame.kind) {
      case "DATA":
        if (this.stateValue === "connected") {
          this.receiveData(generation, raw, frame);
        }
        break;
      case "ACK":
        if (this.stateValue === "connected") {
          this.receiveAck(generation, frame);
        }
        break;
      case "CLOSE":
        this.receiveClose(generation);
        break;
      case "CLOSE_ACK":
        this.receiveCloseAck(generation);
        break;
    }
  }

  private handleSocketError(generation: number, event: unknown): void {
    if (generation !== this.currentGeneration) {
      return;
    }
    this.diagnostic("WebSocket emitted an error event.", event);
    if (
      this.stateValue === "connecting" &&
      this.binding?.socket.readyState !== WEBSOCKET_OPEN
    ) {
      this.handleUnexpectedDisconnect(generation, event);
    }
  }

  private handleSocketClose(generation: number, event: unknown): void {
    if (generation !== this.currentGeneration) {
      return;
    }
    if (this.peerCloseInProgressGeneration === generation) {
      return;
    }
    if (this.stateValue === "closing") {
      this.finishLocalClose(generation);
      return;
    }
    this.handleUnexpectedDisconnect(generation, event);
  }

  private handleUnexpectedDisconnect(generation: number, cause: unknown): void {
    if (generation !== this.currentGeneration) {
      return;
    }
    const binding = this.invalidateBinding(generation);
    this.stateValue = "idle";
    const connectDeferred = this.connectDeferred;
    this.connectDeferred = undefined;
    connectDeferred?.reject(
      new SDKError(
        sdkErrorCodes.transportNotConnected,
        "WebSocket disconnected before connecting.",
        "not_sent",
        { cause },
      ),
    );
    this.rejectAllForDisconnect(cause);
    this.resetConnectionLocalState();
    if (binding?.socket.readyState !== WEBSOCKET_CLOSED) {
      try {
        binding?.socket.close();
      } catch (closeCause) {
        this.diagnostic("Failed to close disconnected WebSocket.", closeCause);
      }
    }

    const receiver = this.receiver;
    if (receiver !== undefined) {
      try {
        receiver.disconnected(
          new SDKError(
            sdkErrorCodes.transportDisconnected,
            "WebSocket connection was lost.",
            "unknown",
            { cause },
          ),
        );
      } catch (receiverCause) {
        this.diagnostic("Transport receiver disconnected callback threw.", receiverCause);
      }
    }
    if (this.stateValue === "idle" && this.currentGeneration === 0) {
      this.emitState("idle");
    }
  }

  private receiveData(generation: number, raw: string, frame: DataFrame): void {
    const digest = raw;
    if (frame.transferId < this.highestAcceptedTransferId) {
      return;
    }
    if (frame.transferId === this.highestAcceptedTransferId) {
      if (digest === this.highestAcceptedDigest) {
        this.sendControl(
          { kind: "ACK", transferId: frame.transferId, chunkIndex: 0 },
          generation,
        );
      } else {
        this.diagnostic("Dropped conflicting DATA for the current high-water ID.");
      }
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(frame.payload);
    } catch (cause) {
      this.diagnostic("Dropped DATA with malformed JSON payload.", cause);
      return;
    }
    if (!isJsonValue(message)) {
      this.diagnostic("Dropped DATA whose payload is not a JSON value.");
      return;
    }

    const receiver = this.receiver;
    if (receiver === undefined) {
      this.diagnostic("Dropped DATA because no Session receiver is bound.");
      return;
    }
    try {
      receiver.accept(message);
    } catch (cause) {
      this.diagnostic("Transport receiver accept callback threw; DATA was not ACKed.", cause);
      return;
    }

    if (
      generation !== this.currentGeneration ||
      this.stateValue !== "connected" ||
      this.binding?.generation !== generation
    ) {
      return;
    }

    this.highestAcceptedTransferId = frame.transferId;
    this.highestAcceptedDigest = digest;
    this.sendControl(
      { kind: "ACK", transferId: frame.transferId, chunkIndex: 0 },
      generation,
    );
  }

  private receiveAck(generation: number, frame: AckFrame): void {
    const item = this.active;
    if (
      item === undefined ||
      item.settled ||
      item.generation !== generation ||
      item.transferId !== frame.transferId
    ) {
      return;
    }

    if (item.sending) {
      item.ackReceivedWhileSending = true;
      return;
    }

    this.completeAck(item);
  }

  private completeAck(item: SendItem): void {
    item.settled = true;
    this.clearItemResources(item);
    if (this.active === item) {
      this.active = undefined;
    }
    this.removeQueuedItem(item);
    if (item.delivery === "not_sent") {
      item.delivery = "unknown";
      this.notifyDelivery(item, "unknown");
    }
    item.delivery = "delivered";
    this.notifyDelivery(item, "delivered");
    item.deferred.resolve();
    this.schedulePump();
  }

  private receiveClose(generation: number): void {
    const wasClosing = this.stateValue === "closing";
    if (!wasClosing) {
      this.peerCloseInProgressGeneration = generation;
    }
    try {
      this.sendControl({ kind: "CLOSE_ACK" }, generation);
    } finally {
      if (this.peerCloseInProgressGeneration === generation) {
        this.peerCloseInProgressGeneration = 0;
      }
    }
    if (generation !== this.currentGeneration) {
      return;
    }
    if (this.stateValue === "closing") {
      return;
    }

    const receiver = this.takeReceiver();
    this.rejectAllForClose();
    this.finishPeerClose(generation, receiver);
  }

  private receiveCloseAck(generation: number): void {
    if (this.stateValue === "closing") {
      this.finishLocalClose(generation);
    }
  }

  private schedulePump(): void {
    if (this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    const token = ++this.pumpToken;
    const run = () => {
      if (token !== this.pumpToken) {
        return;
      }
      this.pumpScheduled = false;
      this.pump();
    };
    try {
      this.clock.queueMicrotask(run);
    } catch (cause) {
      this.diagnostic("Protocol clock rejected a FIFO microtask; using native queue.", cause);
      globalThis.queueMicrotask(run);
    }
  }

  private pump(): void {
    if (
      this.stateValue !== "connected" ||
      this.active !== undefined ||
      this.queue.length === 0
    ) {
      return;
    }
    const item = this.queue[0];
    if (item === undefined) {
      return;
    }
    if (item.generation !== this.currentGeneration) {
      this.failItem(
        item,
        new SDKError(
          sdkErrorCodes.transportDisconnected,
          "DATA belongs to a stale connection.",
          "not_sent",
        ),
      );
      return;
    }
    if (item.options.signal?.aborted === true) {
      this.failItem(item, new TransportSendCancelledError(item.delivery));
      return;
    }
    if (this.isDeadlineReached(item.options.deadlineAt)) {
      this.failItem(item, this.deadlineError(item.delivery));
      return;
    }

    this.active = item;
    this.transmitActive(item);
  }

  private transmitActive(item: SendItem): void {
    if (
      item.settled ||
      this.active !== item ||
      this.stateValue !== "connected" ||
      item.generation !== this.currentGeneration
    ) {
      return;
    }
    if (item.options.signal?.aborted === true) {
      this.failItem(item, new TransportSendCancelledError(item.delivery));
      return;
    }
    if (this.isDeadlineReached(item.options.deadlineAt)) {
      this.failItem(item, this.deadlineError(item.delivery));
      return;
    }

    const socket = this.binding?.socket;
    if (socket === undefined || socket.readyState !== WEBSOCKET_OPEN) {
      this.handleUnexpectedDisconnect(item.generation, undefined);
      return;
    }

    item.attempts += 1;
    item.sending = true;
    try {
      socket.send(item.snapshot);
    } catch (cause) {
      item.sending = false;
      const delivery = item.delivery;
      this.failItem(
        item,
        new SDKError(
          sdkErrorCodes.transportDisconnected,
          "WebSocket.send failed.",
          delivery,
          { cause },
        ),
      );
      if (socket.readyState !== WEBSOCKET_OPEN) {
        this.handleUnexpectedDisconnect(item.generation, cause);
      }
      return;
    }
    item.sending = false;

    if (item.settled) {
      return;
    }
    if (item.ackReceivedWhileSending) {
      item.ackReceivedWhileSending = false;
      this.completeAck(item);
      return;
    }
    if (item.delivery === "not_sent") {
      item.delivery = "unknown";
      this.notifyDelivery(item, "unknown");
    }
    if (item.settled) {
      return;
    }
    try {
      item.ackTimer = this.clock.setTimeout(() => {
        if (
          item.settled ||
          this.active !== item ||
          item.generation !== this.currentGeneration
        ) {
          return;
        }
        item.ackTimer = undefined;
        if (item.options.signal?.aborted === true) {
          this.failItem(item, new TransportSendCancelledError(item.delivery));
          return;
        }
        if (this.isDeadlineReached(item.options.deadlineAt)) {
          this.failItem(item, this.deadlineError(item.delivery));
          return;
        }
        if (item.attempts >= MAX_SEND_ATTEMPTS) {
          this.failItem(
            item,
            new SDKError(
              sdkErrorCodes.deliveryUnconfirmed,
              `No ACK after ${MAX_SEND_ATTEMPTS} DATA attempts.`,
              "unknown",
            ),
          );
          return;
        }
        this.transmitActive(item);
      }, ACK_TIMEOUT_MS);
    } catch (cause) {
      this.failItem(
        item,
        new SDKError(
          sdkErrorCodes.transportDisconnected,
          "Failed to schedule DATA acknowledgement timer.",
          item.delivery,
          { cause },
        ),
      );
    }
  }

  private installCancellation(item: SendItem): void {
    const signal = item.options.signal;
    if (signal !== undefined) {
      const listener = () => {
        this.failItem(item, new TransportSendCancelledError(item.delivery));
      };
      item.abortListener = listener;
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) {
        listener();
        return;
      }
    }

    this.scheduleDeadlineTimer(item);
  }

  private scheduleDeadlineTimer(item: SendItem): void {
    const deadlineAt = item.options.deadlineAt;
    if (
      item.settled ||
      deadlineAt === undefined ||
      !Number.isFinite(deadlineAt)
    ) {
      return;
    }
    const remaining = deadlineAt - this.clock.now();
    if (remaining <= 0) {
      this.failItem(item, this.deadlineError(item.delivery));
      return;
    }
    try {
      item.deadlineTimer = this.clock.setTimeout(() => {
        item.deadlineTimer = undefined;
        if (this.isDeadlineReached(deadlineAt)) {
          this.failItem(item, this.deadlineError(item.delivery));
        } else {
          this.scheduleDeadlineTimer(item);
        }
      }, Math.min(remaining, MAX_TIMER_DELAY_MS));
    } catch (cause) {
      this.failItem(
        item,
        new SDKError(
          sdkErrorCodes.transportDisconnected,
          "Failed to schedule DATA deadline timer.",
          item.delivery,
          { cause },
        ),
      );
    }
  }

  private failItem(item: SendItem, error: unknown): void {
    if (item.settled) {
      return;
    }
    item.settled = true;
    this.clearItemResources(item);
    if (this.active === item) {
      this.active = undefined;
    }
    this.removeQueuedItem(item);
    item.deferred.reject(error);
    this.schedulePump();
  }

  private removeQueuedItem(item: SendItem): void {
    const index = this.queue.indexOf(item);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.queuedBytes -= item.byteLength;
      if (this.queuedBytes < 0) {
        this.queuedBytes = 0;
      }
    }
  }

  private clearItemResources(item: SendItem): void {
    if (item.ackTimer !== undefined) {
      this.clock.clearTimeout(item.ackTimer);
      item.ackTimer = undefined;
    }
    if (item.deadlineTimer !== undefined) {
      this.clock.clearTimeout(item.deadlineTimer);
      item.deadlineTimer = undefined;
    }
    if (item.abortListener !== undefined && item.options.signal !== undefined) {
      item.options.signal.removeEventListener("abort", item.abortListener);
      item.abortListener = undefined;
    }
  }

  private rejectAllForDisconnect(cause: unknown): void {
    const items = [...this.queue];
    for (const item of items) {
      const delivery = item === this.active ? item.delivery : "not_sent";
      this.failItem(
        item,
        new SDKError(
          sdkErrorCodes.transportDisconnected,
          "WebSocket connection was lost while DATA was pending.",
          delivery,
          { cause },
        ),
      );
    }
  }

  private rejectAllForClose(): void {
    const items = [...this.queue];
    for (const item of items) {
      const delivery = item === this.active ? item.delivery : "not_sent";
      this.failItem(
        item,
        new SDKError(
          sdkErrorCodes.sessionClosed,
          "Transport closed while DATA was pending.",
          delivery,
        ),
      );
    }
  }

  private notifyDelivery(
    item: SendItem,
    delivery: Exclude<DeliveryState, "not_sent">,
  ): void {
    try {
      item.options.onDeliveryChange?.(delivery);
    } catch (cause) {
      this.diagnostic("Transport delivery observer threw.", cause);
    }
  }

  private sendControl(frame: TransportFrame, generation: number): boolean {
    if (generation !== this.currentGeneration) {
      return false;
    }
    const socket = this.binding?.socket;
    if (socket === undefined || socket.readyState !== WEBSOCKET_OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (cause) {
      this.diagnostic(`Failed to send ${frame.kind} control frame.`, cause);
      return false;
    }
  }

  private finishLocalClose(generation: number): void {
    if (generation !== this.currentGeneration) {
      return;
    }
    const binding = this.invalidateBinding(generation);
    this.clearCloseTimer();
    this.resetConnectionLocalState();
    const closeDeferred = this.closeDeferred;
    this.closeDeferred = undefined;
    const connectDeferred = this.connectDeferred;
    this.connectDeferred = undefined;
    this.stateValue = "closed";
    connectDeferred?.reject(this.notConnectedError("Transport was closed."));
    closeDeferred?.resolve();
    closeSocket(binding?.socket, this.onDiagnostic);
    if (this.stateValue === "closed" && this.currentGeneration === 0) {
      this.emitState("closed");
    }
  }

  private finishPeerClose(
    generation: number,
    receiver: TransportReceiver | undefined,
  ): void {
    if (generation !== this.currentGeneration) {
      return;
    }
    const binding = this.invalidateBinding(generation);
    this.clearCloseTimer();
    this.resetConnectionLocalState();
    const connectDeferred = this.connectDeferred;
    this.connectDeferred = undefined;
    this.stateValue = "closed";
    connectDeferred?.reject(this.notConnectedError("Peer closed the Transport."));
    closeSocket(binding?.socket, this.onDiagnostic);
    if (receiver !== undefined) {
      try {
        receiver.peerClosed();
      } catch (cause) {
        this.diagnostic("Transport receiver peerClosed callback threw.", cause);
      }
    }
    if (this.stateValue === "closed" && this.currentGeneration === 0) {
      this.emitState("closed");
    }
  }

  private invalidateBinding(generation: number): SocketBinding | undefined {
    if (generation !== this.currentGeneration) {
      return undefined;
    }
    const binding = this.binding;
    this.currentGeneration = 0;
    this.binding = undefined;
    if (binding !== undefined) {
      try {
        binding.socket.removeEventListener("open", binding.onOpen);
        binding.socket.removeEventListener("message", binding.onMessage);
        binding.socket.removeEventListener("close", binding.onClose);
        binding.socket.removeEventListener("error", binding.onError);
      } catch (cause) {
        this.diagnostic("Failed to detach WebSocket listeners.", cause);
      }
    }
    return binding;
  }

  private resetConnectionLocalState(): void {
    this.nextTransferId = 1;
    this.highestAcceptedTransferId = 0;
    this.highestAcceptedDigest = undefined;
    this.active = undefined;
    this.queue = [];
    this.queuedBytes = 0;
    this.pumpScheduled = false;
    this.pumpToken += 1;
    this.peerCloseInProgressGeneration = 0;
    this.clearCloseTimer();
  }

  private allocateTransferId(): number | undefined {
    if (this.nextTransferId > Number.MAX_SAFE_INTEGER) {
      return undefined;
    }
    const id = this.nextTransferId;
    this.nextTransferId += 1;
    return id;
  }

  private isDeadlineReached(deadlineAt: number | undefined): boolean {
    return deadlineAt !== undefined && this.clock.now() >= deadlineAt;
  }

  private deadlineError(delivery: DeliveryState): SDKError {
    return new SDKError(
      sdkErrorCodes.requestTimeout,
      "Transport deadline was reached.",
      delivery,
    );
  }

  private notConnectedError(message: string): SDKError {
    return new SDKError(
      sdkErrorCodes.transportNotConnected,
      message,
      "not_sent",
    );
  }

  private takeReceiver(): TransportReceiver | undefined {
    const receiver = this.receiver;
    this.receiver = undefined;
    return receiver;
  }

  private notifyLocalClosed(receiver: TransportReceiver | undefined): void {
    if (receiver === undefined) {
      return;
    }
    try {
      receiver.localClosed();
    } catch (cause) {
      this.diagnostic("Transport receiver localClosed callback threw.", cause);
    }
  }

  private clearCloseTimer(): void {
    if (this.closeTimer !== undefined) {
      this.clock.clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
  }

  private setState(state: TransportState): void {
    if (this.stateValue === state) {
      return;
    }
    this.stateValue = state;
    this.emitState(state);
  }

  private emitState(state: TransportState): void {
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch (cause) {
        this.diagnostic("Transport state listener threw.", cause);
      }
    }
  }

  private diagnostic(message: string, cause?: unknown): void {
    try {
      this.onDiagnostic?.(message, cause);
    } catch {
      // Diagnostics must never change protocol behavior.
    }
  }
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T): void {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    },
    reject(reason: unknown): void {
      if (!settled) {
        settled = true;
        rejectPromise(reason);
      }
    },
    get settled(): boolean {
      return settled;
    },
  };
}

function getMessageData(event: unknown): unknown {
  if (event !== null && typeof event === "object" && "data" in event) {
    return (event as { data: unknown }).data;
  }
  return event;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function parseTransportFrame(value: unknown): TransportFrame | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return undefined;
  }
  switch (value.kind) {
    case "DATA":
      if (
        !hasOnlyKeys(value, [
          "kind",
          "transferId",
          "chunkIndex",
          "chunkCount",
          "payload",
        ]) ||
        !isPositiveSafeInteger(value.transferId) ||
        value.chunkIndex !== 0 ||
        value.chunkCount !== 1 ||
        typeof value.payload !== "string"
      ) {
        return undefined;
      }
      return {
        kind: "DATA",
        transferId: value.transferId,
        chunkIndex: 0,
        chunkCount: 1,
        payload: value.payload,
      };
    case "ACK":
      if (
        !hasOnlyKeys(value, ["kind", "transferId", "chunkIndex"]) ||
        !isPositiveSafeInteger(value.transferId) ||
        value.chunkIndex !== 0
      ) {
        return undefined;
      }
      return {
        kind: "ACK",
        transferId: value.transferId,
        chunkIndex: 0,
      };
    case "CLOSE":
      return hasOnlyKeys(value, ["kind"]) ? { kind: "CLOSE" } : undefined;
    case "CLOSE_ACK":
      return hasOnlyKeys(value, ["kind"]) ? { kind: "CLOSE_ACK" } : undefined;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function closeSocket(
  socket: WebSocketLike | undefined,
  onDiagnostic: ProtocolRuntimeOptions["onDiagnostic"],
): void {
  if (
    socket === undefined ||
    socket.readyState === WEBSOCKET_CLOSED ||
    socket.readyState === WEBSOCKET_CLOSING
  ) {
    return;
  }
  try {
    socket.close(1000, "Transport closed");
  } catch (cause) {
    try {
      onDiagnostic?.("Failed to close WebSocket.", cause);
    } catch {
      // Diagnostics must never change protocol behavior.
    }
  }
}
