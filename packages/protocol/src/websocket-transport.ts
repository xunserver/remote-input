import type { ProtocolClock, TimeoutHandle } from "./clock.js";
import { systemClock } from "./clock.js";
import {
  ACK_TIMEOUT_MS,
  CHUNK_PAYLOAD_BYTES,
  CLOSE_ACK_TIMEOUT_MS,
  MAX_CHUNKS_PER_TRANSFER,
  MAX_IN_FLIGHT_CHUNKS,
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
import {
  queueProtocolTrace,
  type ProtocolTraceDetails,
  type ProtocolTraceLevel,
  type ProtocolTraceListener,
} from "./trace.js";
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
 * 浏览器 WebSocket 与 `ws` 包共有的 EventTarget 形状子集。
 * V1 只接收文本帧。
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
  /** Maximum number of DATA chunks in flight for the active transfer. */
  chunkWindowSize?: number;
}

export type TransportStateListener = (state: TransportState) => void;

type DataFrame = {
  kind: "DATA";
  transferId: number;
  chunkIndex: number;
  chunkCount: number;
  payload: string;
};

type AckFrame = {
  kind: "ACK";
  transferId: number;
  chunkIndex: number;
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

type EncodedChunk = {
  readonly chunkIndex: number;
  readonly snapshot: string;
  readonly byteLength: number;
};

type ChunkSendState = {
  readonly chunk: EncodedChunk;
  attempts: number;
  settled: boolean;
  sending: boolean;
  ackReceivedWhileSending: boolean;
  ackTimer: TimeoutHandle | undefined;
};

type SendItem = {
  readonly transferId: number;
  readonly generation: number;
  readonly chunks: readonly EncodedChunk[];
  readonly byteLength: number;
  readonly options: NormalizedSendOptions;
  readonly deferred: Deferred<void>;
  delivery: DeliveryState;
  deliveryUnknownNotified: boolean;
  settled: boolean;
  nextChunkIndex: number;
  readonly inFlight: Map<number, ChunkSendState>;
  ackedChunks: number;
  deadlineTimer: TimeoutHandle | undefined;
  abortListener: (() => void) | undefined;
};

type IncomingTransfer = {
  readonly transferId: number;
  readonly chunkCount: number;
  readonly chunks: Map<number, string>;
  totalPayloadBytes: number;
  delivering: boolean;
};

type CompletedTransfer = {
  readonly transferId: number;
  readonly chunkCount: number;
  readonly chunks: Map<number, string>;
};

type NormalizedSendOptions = {
  readonly signal: AbortSignal | undefined;
  readonly deadlineAt: number | undefined;
  readonly onDeliveryChange:
    | ((delivery: Exclude<DeliveryState, "not_sent">) => void)
    | undefined;
};

/** Session 已由其他终态完成后，用于中止遗留发送工作的内部错误。 */
export class TransportSendCancelledError extends Error {
  readonly delivery: DeliveryState;

  constructor(delivery: DeliveryState) {
    super("Transport send was cancelled by its owning Session.");
    this.name = "TransportSendCancelledError";
    this.delivery = delivery;
  }
}

/**
 * 在 WebSocket 上实现带 ACK、重试和关闭握手的可靠传输。
 * 逻辑 transfer 严格按 FIFO 发送，transfer 内的 DATA chunk 受窗口限制；
 * 连接代次用于隔离重连前后的事件与队列状态。
 */
export class WebSocketTransport implements Transport {
  private readonly url: string;
  private readonly socketFactory: WebSocketFactory | undefined;
  private readonly clock: ProtocolClock;
  private readonly onDiagnostic: ProtocolRuntimeOptions["onDiagnostic"];
  private readonly onTrace: ProtocolTraceListener | undefined;
  private readonly traceLevel: ProtocolTraceLevel;
  private readonly traceChunksEnabled: boolean;
  private readonly chunkWindowSize: number;
  private readonly stateListeners = new Set<TransportStateListener>();
  private readonly encoder = new TextEncoder();

  private stateValue: TransportState = "idle";
  private receiver: TransportReceiver | undefined;
  private binding: SocketBinding | undefined;
  private connectDeferred: Deferred<void> | undefined;
  private closeDeferred: Deferred<void> | undefined;
  private closeTimer: TimeoutHandle | undefined;

  // 每次 attach 都分配新的连接代次；旧连接迟到的事件和定时器会因代次不匹配而失效。
  private generationCounter = 0;
  private currentGeneration = 0;

  // transferId 和接收高水位只在当前连接代次内有效，重连后从初始值重新开始。
  private nextTransferId = 1;
  private highestAcceptedTransferId = 0;
  private incomingTransfer: IncomingTransfer | undefined;
  private completedTransfer: CompletedTransfer | undefined;

  // queue 按 SessionMessage 保持 FIFO；active transfer 内部使用 chunk window。
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
    this.onTrace = options.onTrace;
    const traceLevel = options.traceLevel ?? "summary";
    if (traceLevel !== "summary" && traceLevel !== "chunks") {
      throw new RangeError('traceLevel must be either "summary" or "chunks".');
    }
    this.traceLevel = traceLevel;
    this.traceChunksEnabled = this.onTrace !== undefined && traceLevel === "chunks";
    const chunkWindowSize = options.chunkWindowSize ?? MAX_IN_FLIGHT_CHUNKS;
    if (
      !Number.isSafeInteger(chunkWindowSize) ||
      chunkWindowSize < 1 ||
      chunkWindowSize > MAX_CHUNKS_PER_TRANSFER
    ) {
      throw new RangeError(
        `chunkWindowSize must be a safe integer from 1 to ${MAX_CHUNKS_PER_TRANSFER}.`,
      );
    }
    this.chunkWindowSize = chunkWindowSize;
  }

  /**
   * 接管服务端已接受的套接字。已打开的套接字会同步进入 connected；
   * 仍在连接中的套接字可通过 `connect()` 或后续直接调用 `attach()` 等待。
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

    // 入队的是每个 chunk 的最终编码快照；重试始终发送相同内容，不受调用方后续修改影响。
    let chunks: readonly EncodedChunk[];
    let payloadByteLength: number;
    let byteLength: number;
    let payload: string;
    let messageSnapshot: SessionMessage;
    try {
      const snapshot = snapshotJsonValue(message);
      if (snapshot === undefined || !isSessionMessage(snapshot)) {
        throw new TypeError("Message is not a descriptor-safe SessionMessage.");
      }
      messageSnapshot = snapshot;
      payload = JSON.stringify(messageSnapshot);
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

    payloadByteLength = this.encoder.encode(payload).byteLength;
    // Encoding can run user-controlled getters/proxies and may cross a
    // connection, cancellation, or deadline boundary. Re-check those states
    // before returning a size error so the original terminal cause wins.
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
    if (payloadByteLength > MAX_MESSAGE_BYTES) {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.messageTooLarge,
          `Encoded Session payload exceeds ${MAX_MESSAGE_BYTES} bytes.`,
          "not_sent",
        ),
      );
    }
    // The final frame snapshots can only be larger than their inner payload.
    // This lower-bound check avoids doing a full split when the queue is
    // already certainly over budget; the exact snapshot sum is checked below.
    if (
      this.queue.length >= MAX_QUEUED_MESSAGES ||
      this.queuedBytes + payloadByteLength > MAX_QUEUED_BYTES
    ) {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.transportQueueFull,
          "Transport DATA queue is full.",
          "not_sent",
        ),
      );
    }
    try {
      const encoded = encodeDataChunks(
        transferId,
        payload,
        this.encoder,
        payloadByteLength,
      );
      chunks = encoded.chunks;
      byteLength = encoded.byteLength;
    } catch (cause) {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.encodeError,
          "Session message could not be split into DATA chunks safely.",
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
    if (
      payloadByteLength > MAX_MESSAGE_BYTES ||
      chunks.length > MAX_CHUNKS_PER_TRANSFER ||
      chunks.some((chunk) => chunk.byteLength > MAX_MESSAGE_BYTES)
    ) {
      return Promise.reject(
        new SDKError(
          sdkErrorCodes.messageTooLarge,
          `Encoded Session payload or DATA chunk exceeds ${MAX_MESSAGE_BYTES} bytes.`,
          "not_sent",
        ),
      );
    }
    // active DATA 在进入终态前仍位于 queue[0]，因此队列预算也包含正在等待 ACK 的消息。
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
      chunks,
      byteLength,
      options: sendOptions,
      deferred,
      delivery: "not_sent",
      deliveryUnknownNotified: false,
      settled: false,
      nextChunkIndex: 0,
      inFlight: new Map(),
      ackedChunks: 0,
      deadlineTimer: undefined,
      abortListener: undefined,
    };
    this.queue.push(item);
    this.queuedBytes += byteLength;
    this.trace("transfer.queued", {
      generation,
      transferId,
      messageType: messageSnapshot.type,
      requestId: messageSnapshot.requestId,
      payloadBytes: payloadByteLength,
      chunkCount: chunks.length,
      frameBytes: byteLength,
      queueTransfers: this.queue.length,
      queuedBytes: this.queuedBytes,
      window: this.chunkWindowSize,
    });
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

    // 先同步冻结 FIFO 并拒绝全部 DATA，再让 CLOSE 绕过队列等待 CLOSE_ACK。
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
          this.receiveData(generation, frame);
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
    // 先使当前代次失效，再清理旧队列并通知 Session；重连不会恢复未完成的 DATA。
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

  /**
   * 接收并重组一个 transfer。非最后 chunk 在可靠缓存后立即 ACK；最后一个
   * chunk 只有在完整 payload 已交给 Session 后才 ACK。这样窗口可以前进，
   * 同时 send() 的最终 resolve 仍然代表完整 SessionMessage 已交付。
   */
  private receiveData(generation: number, frame: DataFrame): void {
    if (frame.chunkCount > MAX_CHUNKS_PER_TRANSFER) {
      this.diagnostic("Dropped DATA with an excessive chunk count.");
      return;
    }
    const chunkBytes = this.encoder.encode(frame.payload).byteLength;
    // 保留旧的单帧输入兼容性；真正的多 chunk transfer 每段必须符合测试尺寸。
    if (
      (frame.chunkCount > 1 && chunkBytes > CHUNK_PAYLOAD_BYTES) ||
      chunkBytes > MAX_MESSAGE_BYTES
    ) {
      this.diagnostic("Dropped DATA with an oversized chunk payload.");
      return;
    }
    if (this.traceChunksEnabled) {
      this.trace("chunk.received", {
        generation,
        transferId: frame.transferId,
        chunkIndex: frame.chunkIndex,
        chunkCount: frame.chunkCount,
        chunkBytes,
      }, "chunks");
    }

    const completed = this.completedTransfer;
    if (completed !== undefined && frame.transferId === completed.transferId) {
      if (
        frame.chunkCount !== completed.chunkCount ||
        completed.chunks.get(frame.chunkIndex) !== frame.payload
      ) {
        this.diagnostic("Dropped conflicting DATA for the completed transfer.");
        return;
      }
      if (this.traceChunksEnabled) {
        this.trace("chunk.duplicate", {
          generation,
          transferId: frame.transferId,
          chunkIndex: frame.chunkIndex,
          chunkCount: frame.chunkCount,
          completed: true,
        }, "chunks");
      }
      this.sendControl(
        { kind: "ACK", transferId: frame.transferId, chunkIndex: frame.chunkIndex },
        generation,
        completed.chunkCount,
      );
      return;
    }

    if (frame.transferId <= this.highestAcceptedTransferId) {
      return;
    }

    let incoming = this.incomingTransfer;
    if (incoming === undefined || frame.transferId > incoming.transferId) {
      incoming = {
        transferId: frame.transferId,
        chunkCount: frame.chunkCount,
        chunks: new Map(),
        totalPayloadBytes: 0,
        delivering: false,
      };
      this.incomingTransfer = incoming;
    }
    if (
      incoming.transferId !== frame.transferId ||
      incoming.chunkCount !== frame.chunkCount
    ) {
      this.diagnostic("Dropped DATA with a conflicting transfer shape.");
      return;
    }
    if (incoming.delivering) {
      this.diagnostic("Ignored reentrant DATA while a transfer is being delivered.");
      return;
    }

    const previous = incoming.chunks.get(frame.chunkIndex);
    if (previous !== undefined) {
      if (previous !== frame.payload) {
        this.diagnostic("Dropped conflicting DATA for a partial transfer.");
        return;
      }
      if (this.traceChunksEnabled) {
        this.trace("chunk.duplicate", {
          generation,
          transferId: frame.transferId,
          chunkIndex: frame.chunkIndex,
          chunkCount: frame.chunkCount,
          completed: false,
        }, "chunks");
      }
      // The completing chunk is ACKed only after full delivery. Other duplicate
      // chunks can be acknowledged immediately while reassembly is incomplete.
      if (incoming.chunks.size < incoming.chunkCount && frame.chunkIndex < frame.chunkCount - 1) {
        this.sendControl(
          { kind: "ACK", transferId: frame.transferId, chunkIndex: frame.chunkIndex },
          generation,
          incoming.chunkCount,
        );
        return;
      }
    } else {
      incoming.chunks.set(frame.chunkIndex, frame.payload);
      incoming.totalPayloadBytes += chunkBytes;
      if (this.traceChunksEnabled) {
        this.trace("chunk.cached", {
          generation,
          transferId: frame.transferId,
          chunkIndex: frame.chunkIndex,
          chunkCount: frame.chunkCount,
          receivedChunks: incoming.chunks.size,
          totalPayloadBytes: incoming.totalPayloadBytes,
        }, "chunks");
      }
    }
    if (incoming.totalPayloadBytes > MAX_MESSAGE_BYTES) {
      this.diagnostic("Dropped DATA transfer whose reassembled payload is oversized.");
      this.incomingTransfer = undefined;
      return;
    }

    if (incoming.chunks.size < incoming.chunkCount) {
      // Hold the final-chunk ACK until Session.accept has seen the reassembled
      // message; this preserves the public Transport.send() delivery contract.
      if (frame.chunkIndex < frame.chunkCount - 1) {
        this.sendControl(
          { kind: "ACK", transferId: frame.transferId, chunkIndex: frame.chunkIndex },
          generation,
          incoming.chunkCount,
        );
      }
      return;
    }

    const payload = Array.from({ length: incoming.chunkCount }, (_, index) =>
      incoming.chunks.get(index) ?? ""
    ).join("");
    this.trace("transfer.reassembled", {
      generation,
      transferId: frame.transferId,
      chunkCount: incoming.chunkCount,
      payloadBytes: incoming.totalPayloadBytes,
    });
    let message: unknown;
    try {
      message = JSON.parse(payload);
    } catch (cause) {
      this.diagnostic("Dropped reassembled DATA with malformed JSON payload.", cause);
      return;
    }
    if (!isJsonValue(message)) {
      this.diagnostic("Dropped reassembled DATA whose payload is not a JSON value.");
      return;
    }

    const receiver = this.receiver;
    if (receiver === undefined) {
      this.diagnostic("Dropped DATA because no Session receiver is bound.");
      return;
    }
    const messageDetails = isSessionMessage(message)
      ? {
        messageType: message.type,
        requestId: message.requestId,
      }
      : {
        messageType: "invalid-session-message",
        requestId: null,
      };
    this.trace("receiver.accept.start", {
      generation,
      transferId: frame.transferId,
      ...messageDetails,
    });
    incoming.delivering = true;
    try {
      receiver.accept(message);
    } catch (cause) {
      incoming.delivering = false;
      this.diagnostic("Transport receiver accept callback threw; DATA was not ACKed.", cause);
      return;
    }
    incoming.delivering = false;
    this.trace("receiver.accept.done", {
      generation,
      transferId: frame.transferId,
      ...messageDetails,
    });

    if (
      generation !== this.currentGeneration ||
      this.stateValue !== "connected" ||
      this.binding?.generation !== generation ||
      this.incomingTransfer !== incoming ||
      this.highestAcceptedTransferId >= frame.transferId
    ) {
      return;
    }

    this.highestAcceptedTransferId = frame.transferId;
    this.completedTransfer = {
      transferId: frame.transferId,
      chunkCount: incoming.chunkCount,
      chunks: new Map(incoming.chunks),
    };
    this.incomingTransfer = undefined;
    const completingChunks = new Set([
      frame.chunkIndex,
      frame.chunkCount - 1,
    ]);
    for (const chunkIndex of completingChunks) {
      this.sendControl(
        { kind: "ACK", transferId: frame.transferId, chunkIndex },
        generation,
        incoming.chunkCount,
      );
    }
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

    const chunk = item.inFlight.get(frame.chunkIndex);
    if (chunk === undefined || chunk.settled) {
      return;
    }
    if (this.traceChunksEnabled) {
      this.trace("chunk.ack.received", {
        generation,
        transferId: frame.transferId,
        chunkIndex: frame.chunkIndex,
        chunkCount: item.chunks.length,
        attempt: chunk.attempts,
        acknowledgedChunks: item.ackedChunks + 1,
      }, "chunks");
    }

    // WebSocketLike 适配器可能在 send() 调用栈内同步触发 ACK，延迟完成以保持 active 一致。
    if (chunk.sending) {
      chunk.ackReceivedWhileSending = true;
      return;
    }

    this.completeChunk(item, chunk);
  }

  private completeChunk(item: SendItem, chunk: ChunkSendState): void {
    if (item.settled || chunk.settled) {
      return;
    }
    chunk.settled = true;
    if (chunk.ackTimer !== undefined) {
      this.clock.clearTimeout(chunk.ackTimer);
      chunk.ackTimer = undefined;
    }
    item.inFlight.delete(chunk.chunk.chunkIndex);
    item.ackedChunks += 1;
    if (item.ackedChunks === item.chunks.length) {
      this.completeItem(item);
      return;
    }
    this.schedulePump();
  }

  private completeItem(item: SendItem): void {
    if (item.settled) {
      return;
    }
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
    this.trace("transfer.completed", {
      generation: item.generation,
      transferId: item.transferId,
      chunkCount: item.chunks.length,
      frameBytes: item.byteLength,
      queueTransfers: this.queue.length,
      queuedBytes: this.queuedBytes,
    });
    item.deferred.resolve();
    this.schedulePump();
  }

  /**
   * 收到 CLOSE 始终先回复 CLOSE_ACK。双方同时关闭时保留本端原有代次和定时器，
   * 继续等待自己的 CLOSE_ACK，避免提前结束握手。
   */
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

  /**
   * 下一项通过微任务调度，避免在 resolve/reject/abort 的重入调用栈中继续发送；
   * token 会废弃连接重置前已经排队的旧 pump。
   */
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
    if (this.stateValue !== "connected") {
      return;
    }

    let item = this.active;
    if (item === undefined) {
      item = this.queue[0];
      if (item === undefined) {
        return;
      }
      this.active = item;
      this.trace("transfer.started", {
        generation: item.generation,
        transferId: item.transferId,
        chunkCount: item.chunks.length,
        window: this.chunkWindowSize,
        queueTransfers: this.queue.length,
      });
    }
    if (item.settled) {
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

    while (
      !item.settled &&
      this.active === item &&
      item.inFlight.size < this.chunkWindowSize &&
      item.nextChunkIndex < item.chunks.length
    ) {
      const chunk = item.chunks[item.nextChunkIndex];
      if (chunk === undefined) {
        break;
      }
      item.nextChunkIndex += 1;
      const state: ChunkSendState = {
        chunk,
        attempts: 0,
        settled: false,
        sending: false,
        ackReceivedWhileSending: false,
        ackTimer: undefined,
      };
      item.inFlight.set(chunk.chunkIndex, state);
      this.transmitChunk(item, state);
      // A synchronous ACK completes the chunk and schedules another pump. Do
      // not recursively send the next chunk in the same call stack.
      if (state.settled || item.settled) {
        break;
      }
    }
  }

  /** Send or retry one immutable chunk within the active transfer window. */
  private transmitChunk(item: SendItem, chunk: ChunkSendState): void {
    if (
      item.settled ||
      chunk.settled ||
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

    chunk.attempts += 1;
    chunk.sending = true;
    const wasNotSent = item.delivery === "not_sent";
    // Mark the transfer before entering WebSocket.send. A synchronous adapter
    // may deliver an ACK and/or disconnect reentrantly before send() returns;
    // if the call ultimately throws without settling, the state is restored.
    if (wasNotSent) {
      item.delivery = "unknown";
    }
    if (this.traceChunksEnabled) {
      this.trace("chunk.send", {
        generation: item.generation,
        transferId: item.transferId,
        chunkIndex: chunk.chunk.chunkIndex,
        chunkCount: item.chunks.length,
        attempt: chunk.attempts,
        frameBytes: chunk.chunk.byteLength,
        inFlightChunks: item.inFlight.size,
        window: this.chunkWindowSize,
      }, "chunks");
    }
    try {
      socket.send(chunk.chunk.snapshot);
    } catch (cause) {
      chunk.sending = false;
      if (!item.settled && wasNotSent) {
        item.delivery = "not_sent";
      }
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
    chunk.sending = false;

    if (item.settled || chunk.settled) {
      // A synchronous close/abort can settle the item from inside send().
      // The bytes were nevertheless handed to the adapter, so expose the
      // uncertain boundary exactly once before returning.
      if (wasNotSent && item.delivery === "unknown") {
        this.notifyDelivery(item, "unknown");
      }
      return;
    }
    // A synchronous adapter can deliver the ACK from inside socket.send().
    // The first successful send still crosses the public delivery boundary
    // before the ACK can complete the transfer.
    if (wasNotSent && !item.settled) {
      this.notifyDelivery(item, "unknown");
    }
    if (item.settled || chunk.settled) {
      return;
    }
    if (chunk.ackReceivedWhileSending) {
      chunk.ackReceivedWhileSending = false;
      this.completeChunk(item, chunk);
      return;
    }
    try {
      chunk.ackTimer = this.clock.setTimeout(() => {
        if (
          item.settled ||
          chunk.settled ||
          this.active !== item ||
          item.generation !== this.currentGeneration
        ) {
          return;
        }
        chunk.ackTimer = undefined;
        if (item.options.signal?.aborted === true) {
          this.failItem(item, new TransportSendCancelledError(item.delivery));
          return;
        }
        if (this.isDeadlineReached(item.options.deadlineAt)) {
          this.failItem(item, this.deadlineError(item.delivery));
          return;
        }
        if (chunk.attempts >= MAX_SEND_ATTEMPTS) {
          this.failItem(
            item,
            new SDKError(
              sdkErrorCodes.deliveryUnconfirmed,
              `No ACK after ${MAX_SEND_ATTEMPTS} DATA attempts for chunk ${chunk.chunk.chunkIndex}.`,
              "unknown",
            ),
          );
          return;
        }
        this.transmitChunk(item, chunk);
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
    this.trace("transfer.failed", {
      generation: item.generation,
      transferId: item.transferId,
      chunkCount: item.chunks.length,
      delivery: item.delivery,
      reason: traceErrorReason(error),
      queueTransfers: this.queue.length,
      queuedBytes: this.queuedBytes,
    });
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
    for (const chunk of item.inFlight.values()) {
      if (chunk.ackTimer !== undefined) {
        this.clock.clearTimeout(chunk.ackTimer);
        chunk.ackTimer = undefined;
      }
      chunk.settled = true;
    }
    item.inFlight.clear();
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
    // active 项可能已经发出，保留其交付状态；其余排队项确定为 not_sent。
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
    if (delivery === "unknown") {
      if (item.deliveryUnknownNotified) {
        return;
      }
      item.deliveryUnknownNotified = true;
    }
    this.trace("transfer.delivery", {
      generation: item.generation,
      transferId: item.transferId,
      delivery,
    });
    try {
      item.options.onDeliveryChange?.(delivery);
    } catch (cause) {
      this.diagnostic("Transport delivery observer threw.", cause);
    }
  }

  private sendControl(
    frame: TransportFrame,
    generation: number,
    chunkCount?: number,
  ): boolean {
    if (generation !== this.currentGeneration) {
      return false;
    }
    const socket = this.binding?.socket;
    if (socket === undefined || socket.readyState !== WEBSOCKET_OPEN) {
      return false;
    }
    if (frame.kind === "ACK") {
      if (this.traceChunksEnabled) {
        this.trace("ack.send", {
          generation,
          transferId: frame.transferId,
          chunkIndex: frame.chunkIndex,
          ...(chunkCount === undefined ? {} : { chunkCount }),
        }, "chunks");
      }
    } else {
      this.trace("control.send", {
        generation,
        kind: frame.kind,
      });
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
    // 所有传输与去重状态均按连接隔离；递增 token 同时使已排队的旧 pump 失效。
    this.nextTransferId = 1;
    this.highestAcceptedTransferId = 0;
    this.incomingTransfer = undefined;
    this.completedTransfer = undefined;
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
    this.trace("state.changed", {
      generation: this.currentGeneration,
      state,
    });
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
      // 诊断回调不能改变协议行为。
    }
  }

  private trace(
    event: string,
    details: ProtocolTraceDetails,
    level: ProtocolTraceLevel = "summary",
  ): void {
    if (
      this.onTrace === undefined ||
      (level === "chunks" && this.traceLevel !== "chunks")
    ) {
      return;
    }
    try {
      queueProtocolTrace(this.onTrace, {
        at: this.clock.now(),
        layer: "transport",
        event,
        details,
      });
    } catch {
      // A diagnostic/debug clock or event shape must never change transport state.
    }
  }
}

function traceErrorReason(error: unknown): string {
  try {
    if (error instanceof SDKError) {
      return error.code;
    }
  } catch {
    return "error";
  }
  return "error";
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
        !isChunkIndex(value.chunkIndex) ||
        !isPositiveSafeInteger(value.chunkCount) ||
        value.chunkCount > MAX_CHUNKS_PER_TRANSFER ||
        value.chunkIndex >= value.chunkCount ||
        typeof value.payload !== "string"
      ) {
        return undefined;
      }
      return {
        kind: "DATA",
        transferId: value.transferId,
        chunkIndex: value.chunkIndex,
        chunkCount: value.chunkCount,
        payload: value.payload,
      };
    case "ACK":
      if (
        !hasOnlyKeys(value, ["kind", "transferId", "chunkIndex"]) ||
        !isPositiveSafeInteger(value.transferId) ||
        !isChunkIndex(value.chunkIndex)
      ) {
        return undefined;
      }
      return {
        kind: "ACK",
        transferId: value.transferId,
        chunkIndex: value.chunkIndex,
      };
    case "CLOSE":
      return hasOnlyKeys(value, ["kind"]) ? { kind: "CLOSE" } : undefined;
    case "CLOSE_ACK":
      return hasOnlyKeys(value, ["kind"]) ? { kind: "CLOSE_ACK" } : undefined;
    default:
      return undefined;
  }
}

function encodeDataChunks(
  transferId: number,
  payload: string,
  encoder: TextEncoder,
  payloadByteLength = encoder.encode(payload).byteLength,
): {
  chunks: readonly EncodedChunk[];
  payloadByteLength: number;
  byteLength: number;
} {
  const pieces = splitUtf8(payload, encoder, CHUNK_PAYLOAD_BYTES);
  const chunkCount = pieces.length;
  const chunks = pieces.map((piece, chunkIndex) => {
    const frame: DataFrame = {
      kind: "DATA",
      transferId,
      chunkIndex,
      chunkCount,
      payload: piece,
    };
    const snapshot = JSON.stringify(frame);
    return {
      chunkIndex,
      snapshot,
      byteLength: encoder.encode(snapshot).byteLength,
    };
  });
  return {
    chunks,
    payloadByteLength,
    byteLength: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  };
}

/** Split by Unicode code point without ever cutting a UTF-8 sequence. */
function splitUtf8(
  value: string,
  encoder: TextEncoder,
  maxBytes: number,
): string[] {
  const pieces: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of Array.from(value)) {
    const codePointBytes = encoder.encode(codePoint).byteLength;
    if (codePointBytes > maxBytes) {
      throw new RangeError("A Unicode code point exceeds the chunk payload limit.");
    }
    if (current.length > 0 && currentBytes + codePointBytes > maxBytes) {
      pieces.push(current);
      current = "";
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += codePointBytes;
  }
  if (current.length > 0 || pieces.length === 0) {
    pieces.push(current);
  }
  return pieces;
}

function isChunkIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
      // 诊断回调不能改变协议行为。
    }
  }
}
