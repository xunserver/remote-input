import {
  encodeSocketIoAcknowledgementFrame,
  encodeSocketIoDataFrame,
  maxSocketIoAcknowledgementSequence,
  maxSocketIoFrameSequence,
  parseSocketIoTransportFrame,
  socketIoDataFrameHeaderBytes,
  type SocketIoDataFrame,
} from "./socket-io-frames.js";

export const defaultSocketIoChunkPayloadBytes = 16 * 1024;
export const defaultSocketIoSendWindowChunks = 8;
export const defaultSocketIoAcknowledgementTimeoutMs = 2_000;
export const defaultSocketIoMaxRetransmissions = 3;
export const defaultSocketIoMaxMessageBytes = 256 * 1024;
export const defaultSocketIoMaxQueuedMessages = 128;
export const defaultSocketIoMaxQueuedBytes = 4 * 1024 * 1024;
export const defaultSocketIoReassemblyTimeoutMs = 10_000;

const maxTimerDelayMs = 0x7fff_ffff;

/** Socket.IO Transport 的分片、窗口、ACK、重传和资源限制。 */
export type SocketIoTransportOptions = {
  /** 单个 DATA 帧允许携带的最大 payload 字节数。两端必须使用相同值。 */
  chunkPayloadBytes?: number;
  /** 同一方向最多允许同时处于未确认状态的 DATA 帧数。 */
  sendWindowChunks?: number;
  /** 最老未确认 DATA 帧等待累计 ACK 的时间。 */
  ackTimeoutMs?: number;
  /** 初次发送之外允许执行的 Go-Back-N 重传轮数。 */
  maxRetransmissions?: number;
  /** Transport 接受和重组的单条完整消息上限。 */
  maxMessageBytes?: number;
  /** 单连接允许等待确认的完整消息数量上限。 */
  maxQueuedMessages?: number;
  /** 单连接允许等待确认的完整消息总字节数上限。 */
  maxQueuedBytes?: number;
  /** 已开始重组的消息在无进展后允许保留的时间。 */
  reassemblyTimeoutMs?: number;
};

type ResolvedSocketIoTransportOptions = Required<SocketIoTransportOptions>;

type OutboundMessage = {
  byteLength: number;
  remainingChunks: number;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

type OutboundFrame = {
  frameSequence: number;
  encoded: Uint8Array;
  message: OutboundMessage;
  sent: boolean;
  retransmissions: number;
};

type InboundMessage = {
  messageId: number;
  chunkCount: number;
  totalMessageBytes: number;
  nextChunkIndex: number;
  bytes: Uint8Array;
};

export type SocketIoFragmentControllerCallbacks = {
  transmit(frame: Uint8Array): void;
  deliver(message: Uint8Array): void;
  report(error: Error): void;
  fatal(error: Error): void;
};

/**
 * Socket.IO Transport 私有的可靠分帧控制器。
 *
 * 它只处理二进制 Transport 帧，不解析或创建任何应用协议消息。
 */
export class SocketIoFragmentController {
  private readonly options: ResolvedSocketIoTransportOptions;
  private readonly outboundFrames: OutboundFrame[] = [];
  private readonly outboundMessages = new Set<OutboundMessage>();
  private connected = true;
  private queuedBytes = 0;
  private nextFrameSequence = 0;
  private nextMessageId = 0;
  private sendBase = 0;
  private highestSentSequenceExclusive = 0;
  private inFlightFrames = 0;
  private pumpScheduled = false;
  private retransmissionTimer: ReturnType<typeof setTimeout> | null = null;
  private nextInboundFrameSequence = 0;
  private nextInboundMessageId = 0;
  private inboundMessage: InboundMessage | null = null;
  private reassemblyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly callbacks: SocketIoFragmentControllerCallbacks,
    options: SocketIoTransportOptions = {},
  ) {
    this.options = resolveOptions(options);
  }

  send(message: Uint8Array): Promise<void> {
    if (!this.connected) {
      return Promise.reject(new Error("Socket.IO fragment controller is closed."));
    }
    if (message.byteLength > this.options.maxMessageBytes) {
      return Promise.reject(new Error(
        `Socket.IO transport message exceeds ${this.options.maxMessageBytes} bytes.`,
      ));
    }
    if (this.outboundMessages.size >= this.options.maxQueuedMessages) {
      return Promise.reject(new Error(
        `Socket.IO transport has reached its queued message limit of ${this.options.maxQueuedMessages}.`,
      ));
    }
    if (this.queuedBytes + message.byteLength > this.options.maxQueuedBytes) {
      return Promise.reject(new Error(
        `Socket.IO transport has reached its queued byte limit of ${this.options.maxQueuedBytes}.`,
      ));
    }

    const chunkCount = Math.max(1, Math.ceil(message.byteLength / this.options.chunkPayloadBytes));
    if (this.nextFrameSequence + chunkCount > maxSocketIoAcknowledgementSequence) {
      return Promise.reject(new Error("Socket.IO transport frame sequence is exhausted; reconnect the transport."));
    }
    if (this.nextMessageId > maxSocketIoAcknowledgementSequence) {
      return Promise.reject(new Error("Socket.IO transport message ID is exhausted; reconnect the transport."));
    }

    const messageId = this.nextMessageId;
    this.nextMessageId += 1;
    const firstFrameSequence = this.nextFrameSequence;
    this.nextFrameSequence += chunkCount;

    return new Promise<void>((resolve, reject) => {
      const outboundMessage: OutboundMessage = {
        byteLength: message.byteLength,
        remainingChunks: chunkCount,
        settled: false,
        resolve,
        reject,
      };
      this.outboundMessages.add(outboundMessage);
      this.queuedBytes += message.byteLength;

      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const payloadStart = chunkIndex * this.options.chunkPayloadBytes;
        const payloadEnd = Math.min(payloadStart + this.options.chunkPayloadBytes, message.byteLength);
        const payload = message.subarray(payloadStart, payloadEnd);
        const frameSequence = firstFrameSequence + chunkIndex;
        this.outboundFrames.push({
          frameSequence,
          encoded: encodeSocketIoDataFrame({
            frameSequence,
            messageId,
            chunkIndex,
            chunkCount,
            totalMessageBytes: message.byteLength,
            payload,
          }),
          message: outboundMessage,
          sent: false,
          retransmissions: 0,
        });
      }
      this.schedulePump();
    });
  }

  receive(encoded: Uint8Array): void {
    if (!this.connected) return;
    try {
      if (encoded.byteLength > socketIoDataFrameHeaderBytes + this.options.chunkPayloadBytes) {
        throw new Error(
          `Socket.IO transport frame exceeds the ${socketIoDataFrameHeaderBytes + this.options.chunkPayloadBytes}-byte encoded frame limit.`,
        );
      }
      const frame = parseSocketIoTransportFrame(encoded);
      if (frame.kind === "acknowledgement") {
        this.handleAcknowledgement(frame.nextExpectedFrameSequence);
      } else {
        this.handleData(frame);
      }
    } catch (error) {
      this.fail(toError(error));
    }
  }

  close(error: Error): void {
    if (!this.connected) return;
    this.connected = false;
    this.clearRetransmissionTimer();
    this.clearReassemblyTimer();
    for (const message of this.outboundMessages) {
      this.rejectMessage(message, error);
    }
    this.outboundMessages.clear();
    this.outboundFrames.length = 0;
    this.queuedBytes = 0;
    this.inFlightFrames = 0;
    this.inboundMessage = null;
  }

  private schedulePump(): void {
    if (!this.connected || this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (!this.connected) return;
    while (this.inFlightFrames < this.options.sendWindowChunks) {
      const frame = this.outboundFrames.find((candidate) => !candidate.sent);
      if (!frame) break;
      frame.sent = true;
      this.inFlightFrames += 1;
      this.highestSentSequenceExclusive = frame.frameSequence + 1;
      try {
        this.callbacks.transmit(frame.encoded);
      } catch (error) {
        this.fail(toError(error));
        return;
      }
      if (!this.connected) return;
    }
    this.ensureRetransmissionTimer();
  }

  private handleAcknowledgement(nextExpectedFrameSequence: number): void {
    if (nextExpectedFrameSequence > this.highestSentSequenceExclusive) {
      throw new Error(
        `Socket.IO transport ACK ${nextExpectedFrameSequence} exceeds sent sequence ${this.highestSentSequenceExclusive}.`,
      );
    }
    if (nextExpectedFrameSequence <= this.sendBase) {
      return;
    }

    while (this.outboundFrames[0]?.frameSequence < nextExpectedFrameSequence) {
      const acknowledged = this.outboundFrames.shift();
      if (!acknowledged?.sent) {
        throw new Error("Socket.IO transport ACK covers a frame that has not been sent.");
      }
      this.inFlightFrames -= 1;
      acknowledged.message.remainingChunks -= 1;
      if (acknowledged.message.remainingChunks === 0) {
        this.resolveMessage(acknowledged.message);
      }
    }
    this.sendBase = nextExpectedFrameSequence;
    this.restartRetransmissionTimer();
    this.schedulePump();
  }

  private handleData(frame: SocketIoDataFrame): void {
    this.validateDataFrame(frame);
    if (frame.frameSequence < this.nextInboundFrameSequence) {
      this.sendAcknowledgement();
      return;
    }
    if (frame.frameSequence > this.nextInboundFrameSequence) {
      this.sendAcknowledgement();
      return;
    }

    const completedMessage = this.acceptDataFrame(frame);
    this.nextInboundFrameSequence += 1;
    this.sendAcknowledgement();
    if (completedMessage) {
      try {
        this.callbacks.deliver(completedMessage);
      } catch (error) {
        try {
          this.callbacks.report(toError(error));
        } catch {
          // Listener failures must not corrupt Transport framing state or suppress ACK progress.
        }
      }
    }
  }

  private validateDataFrame(frame: SocketIoDataFrame): void {
    if (frame.frameSequence > maxSocketIoFrameSequence) {
      throw new Error("Socket.IO DATA frame sequence is exhausted or invalid.");
    }
    if (frame.chunkCount === 0 || frame.chunkIndex >= frame.chunkCount) {
      throw new Error("Socket.IO DATA frame has an invalid chunk index or count.");
    }
    if (frame.totalMessageBytes > this.options.maxMessageBytes) {
      throw new Error(`Socket.IO DATA frame exceeds the ${this.options.maxMessageBytes}-byte message limit.`);
    }
    if (frame.payload.byteLength > this.options.chunkPayloadBytes) {
      throw new Error(`Socket.IO DATA frame exceeds the ${this.options.chunkPayloadBytes}-byte payload limit.`);
    }

    const expectedChunkCount = Math.max(
      1,
      Math.ceil(frame.totalMessageBytes / this.options.chunkPayloadBytes),
    );
    if (frame.chunkCount !== expectedChunkCount) {
      throw new Error("Socket.IO DATA frame chunk count does not match the total message size.");
    }
    const expectedPayloadBytes = frame.totalMessageBytes === 0
      ? 0
      : frame.chunkIndex === frame.chunkCount - 1
        ? frame.totalMessageBytes - frame.chunkIndex * this.options.chunkPayloadBytes
        : this.options.chunkPayloadBytes;
    if (frame.payload.byteLength !== expectedPayloadBytes) {
      throw new Error("Socket.IO DATA frame payload size does not match its chunk position.");
    }
  }

  private acceptDataFrame(frame: SocketIoDataFrame): Uint8Array | null {
    let message = this.inboundMessage;
    if (!message) {
      if (frame.messageId !== this.nextInboundMessageId || frame.chunkIndex !== 0) {
        throw new Error("Socket.IO DATA frame does not start the next expected message.");
      }
      message = {
        messageId: frame.messageId,
        chunkCount: frame.chunkCount,
        totalMessageBytes: frame.totalMessageBytes,
        nextChunkIndex: 0,
        bytes: new Uint8Array(frame.totalMessageBytes),
      };
      this.inboundMessage = message;
    }
    if (
      frame.messageId !== message.messageId
      || frame.chunkCount !== message.chunkCount
      || frame.totalMessageBytes !== message.totalMessageBytes
      || frame.chunkIndex !== message.nextChunkIndex
    ) {
      throw new Error("Socket.IO DATA frame is inconsistent with the message being reassembled.");
    }

    message.bytes.set(frame.payload, frame.chunkIndex * this.options.chunkPayloadBytes);
    message.nextChunkIndex += 1;
    if (message.nextChunkIndex === message.chunkCount) {
      this.clearReassemblyTimer();
      this.inboundMessage = null;
      this.nextInboundMessageId += 1;
      return message.bytes;
    }
    this.restartReassemblyTimer();
    return null;
  }

  private sendAcknowledgement(): void {
    this.callbacks.transmit(encodeSocketIoAcknowledgementFrame(this.nextInboundFrameSequence));
  }

  private ensureRetransmissionTimer(): void {
    if (!this.connected || this.retransmissionTimer || this.inFlightFrames === 0) return;
    this.retransmissionTimer = setTimeout(() => {
      this.retransmissionTimer = null;
      this.retransmitWindow();
    }, this.options.ackTimeoutMs);
  }

  private restartRetransmissionTimer(): void {
    this.clearRetransmissionTimer();
    this.ensureRetransmissionTimer();
  }

  private retransmitWindow(): void {
    if (!this.connected || this.inFlightFrames === 0) return;
    const inFlight = this.outboundFrames.filter((frame) => frame.sent);
    if (inFlight.some((frame) => frame.retransmissions >= this.options.maxRetransmissions)) {
      this.fail(new Error(
        `Socket.IO transport exceeded ${this.options.maxRetransmissions} retransmissions without ACK progress.`,
      ));
      return;
    }

    for (const frame of inFlight) {
      if (!this.connected || !this.outboundFrames.includes(frame)) continue;
      frame.retransmissions += 1;
      try {
        this.callbacks.transmit(frame.encoded);
      } catch (error) {
        this.fail(toError(error));
        return;
      }
    }
    this.restartRetransmissionTimer();
  }

  private restartReassemblyTimer(): void {
    this.clearReassemblyTimer();
    this.reassemblyTimer = setTimeout(() => {
      this.reassemblyTimer = null;
      this.fail(new Error("Socket.IO transport message reassembly timed out."));
    }, this.options.reassemblyTimeoutMs);
  }

  private clearRetransmissionTimer(): void {
    if (!this.retransmissionTimer) return;
    clearTimeout(this.retransmissionTimer);
    this.retransmissionTimer = null;
  }

  private clearReassemblyTimer(): void {
    if (!this.reassemblyTimer) return;
    clearTimeout(this.reassemblyTimer);
    this.reassemblyTimer = null;
  }

  private resolveMessage(message: OutboundMessage): void {
    if (message.settled) return;
    message.settled = true;
    this.outboundMessages.delete(message);
    this.queuedBytes -= message.byteLength;
    message.resolve();
  }

  private rejectMessage(message: OutboundMessage, error: Error): void {
    if (message.settled) return;
    message.settled = true;
    message.reject(error);
  }

  private fail(error: Error): void {
    if (!this.connected) return;
    this.close(error);
    this.callbacks.fatal(error);
  }
}

function resolveOptions(options: SocketIoTransportOptions): ResolvedSocketIoTransportOptions {
  const resolved = {
    chunkPayloadBytes: options.chunkPayloadBytes ?? defaultSocketIoChunkPayloadBytes,
    sendWindowChunks: options.sendWindowChunks ?? defaultSocketIoSendWindowChunks,
    ackTimeoutMs: options.ackTimeoutMs ?? defaultSocketIoAcknowledgementTimeoutMs,
    maxRetransmissions: options.maxRetransmissions ?? defaultSocketIoMaxRetransmissions,
    maxMessageBytes: options.maxMessageBytes ?? defaultSocketIoMaxMessageBytes,
    maxQueuedMessages: options.maxQueuedMessages ?? defaultSocketIoMaxQueuedMessages,
    maxQueuedBytes: options.maxQueuedBytes ?? defaultSocketIoMaxQueuedBytes,
    reassemblyTimeoutMs: options.reassemblyTimeoutMs ?? defaultSocketIoReassemblyTimeoutMs,
  };
  requirePositiveInteger(resolved.chunkPayloadBytes, "chunkPayloadBytes");
  requirePositiveInteger(resolved.sendWindowChunks, "sendWindowChunks");
  requirePositiveInteger(resolved.ackTimeoutMs, "ackTimeoutMs");
  requireAtMost(resolved.ackTimeoutMs, maxTimerDelayMs, "ackTimeoutMs");
  requireNonNegativeInteger(resolved.maxRetransmissions, "maxRetransmissions");
  requirePositiveInteger(resolved.maxMessageBytes, "maxMessageBytes");
  requirePositiveInteger(resolved.maxQueuedMessages, "maxQueuedMessages");
  requirePositiveInteger(resolved.maxQueuedBytes, "maxQueuedBytes");
  requirePositiveInteger(resolved.reassemblyTimeoutMs, "reassemblyTimeoutMs");
  requireAtMost(resolved.chunkPayloadBytes, defaultSocketIoChunkPayloadBytes, "chunkPayloadBytes");
  requireAtMost(resolved.sendWindowChunks, defaultSocketIoSendWindowChunks, "sendWindowChunks");
  requireAtMost(
    resolved.maxRetransmissions,
    defaultSocketIoMaxRetransmissions,
    "maxRetransmissions",
  );
  requireAtMost(resolved.maxMessageBytes, defaultSocketIoMaxMessageBytes, "maxMessageBytes");
  requireAtMost(resolved.maxQueuedMessages, defaultSocketIoMaxQueuedMessages, "maxQueuedMessages");
  requireAtMost(resolved.maxQueuedBytes, defaultSocketIoMaxQueuedBytes, "maxQueuedBytes");
  requireAtMost(
    resolved.reassemblyTimeoutMs,
    defaultSocketIoReassemblyTimeoutMs,
    "reassemblyTimeoutMs",
  );
  return resolved;
}

function requireAtMost(value: number, maximum: number, name: string): void {
  if (value > maximum) {
    throw new Error(`Socket.IO transport option ${name} must not exceed ${maximum}.`);
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Socket.IO transport option ${name} must be a positive integer.`);
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Socket.IO transport option ${name} must be a non-negative integer.`);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Socket.IO transport framing failed.");
}
