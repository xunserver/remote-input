import type { ProtocolClock, TimeoutHandle } from "./clock.js";
import { systemClock } from "./clock.js";
import type {
  WebSocketFactory,
  WebSocketLike,
} from "./websocket-transport.js";

type TimerRecord = {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
};

/** Deterministic monotonic clock for protocol timers and FIFO microtasks. */
export class FakeClock implements ProtocolClock {
  private currentTime: number;
  private nextTimerId = 1;
  private readonly timers = new Map<number, TimerRecord>();
  private microtasks: Array<() => void> = [];

  constructor(startAt = 0) {
    this.currentTime = startAt;
  }

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): TimeoutHandle {
    const id = this.nextTimerId++;
    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : Number.MAX_VALUE;
    this.timers.set(id, {
      id,
      dueAt: this.currentTime + delay,
      callback,
    });
    return id as TimeoutHandle;
  }

  clearTimeout(handle: TimeoutHandle): void {
    this.timers.delete(handle as number);
  }

  queueMicrotask(callback: () => void): void {
    this.microtasks.push(callback);
  }

  flushMicrotasks(limit = 10_000): void {
    let count = 0;
    while (this.microtasks.length > 0) {
      if (count++ >= limit) {
        throw new Error("FakeClock microtask limit exceeded.");
      }
      const tasks = this.microtasks;
      this.microtasks = [];
      for (const task of tasks) {
        task();
      }
    }
  }

  advanceBy(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError("FakeClock can only advance by a finite non-negative value.");
    }
    this.advanceTo(this.currentTime + deltaMs);
  }

  advanceTo(targetTime: number): void {
    if (!Number.isFinite(targetTime) || targetTime < this.currentTime) {
      throw new RangeError("FakeClock cannot move backwards or to a non-finite time.");
    }

    this.flushMicrotasks();
    for (;;) {
      const next = this.nextDueTimer(targetTime);
      if (next === undefined) {
        break;
      }
      this.currentTime = next.dueAt;
      this.timers.delete(next.id);
      next.callback();
      this.flushMicrotasks();
    }
    this.currentTime = targetTime;
    this.flushMicrotasks();
  }

  runAll(limit = 10_000): void {
    let count = 0;
    this.flushMicrotasks();
    while (this.timers.size > 0) {
      if (count++ >= limit) {
        throw new Error("FakeClock timer limit exceeded.");
      }
      const next = this.nextDueTimer(Number.MAX_VALUE);
      if (next === undefined) {
        break;
      }
      this.advanceTo(next.dueAt);
    }
  }

  get pendingTimerCount(): number {
    return this.timers.size;
  }

  get pendingMicrotaskCount(): number {
    return this.microtasks.length;
  }

  private nextDueTimer(targetTime: number): TimerRecord | undefined {
    let next: TimerRecord | undefined;
    for (const timer of this.timers.values()) {
      if (timer.dueAt > targetTime) {
        continue;
      }
      if (
        next === undefined ||
        timer.dueAt < next.dueAt ||
        (timer.dueAt === next.dueAt && timer.id < next.id)
      ) {
        next = timer;
      }
    }
    return next;
  }
}

export type FakeWebSocketSide = "client" | "server";
export type FakeWebSocketDirection =
  | "client-to-server"
  | "server-to-client";
export type FakeTransportFrameKind = "DATA" | "ACK" | "CLOSE" | "CLOSE_ACK";

export type FakeWebSocketPacket = {
  readonly from: FakeWebSocketSide;
  readonly to: FakeWebSocketSide;
  readonly direction: FakeWebSocketDirection;
  readonly data: string;
  readonly kind: FakeTransportFrameKind | undefined;
  readonly sequence: number;
};

export type FakeDeliveryDirective = {
  drop?: boolean;
  delayMs?: number;
  /** Total number of deliveries, including the original. */
  copies?: number;
  synchronous?: boolean;
  throwError?: unknown;
};

export type FakeWebSocketInterceptor = (
  packet: FakeWebSocketPacket,
) => FakeDeliveryDirective | undefined;

export type FakePacketMatch = {
  direction?: FakeWebSocketDirection;
  kind?: FakeTransportFrameKind;
};

export interface FakeWebSocketPairOptions {
  clock?: ProtocolClock;
  autoOpen?: boolean;
  synchronousDelivery?: boolean;
}

type OneShotRule = {
  readonly match: FakePacketMatch;
  readonly directive: FakeDeliveryDirective;
};

type FakeEvent = {
  readonly type: string;
  readonly target: FakeWebSocket;
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
};

type FakeListener = (event: FakeEvent) => void;

export class FakeWebSocket implements WebSocketLike {
  private readonly listeners = new Map<string, Set<FakeListener>>();
  private state: number;

  readonly side: FakeWebSocketSide;
  readonly sent: string[] = [];

  constructor(
    private readonly pair: FakeWebSocketPair,
    side: FakeWebSocketSide,
    readyState: number,
  ) {
    this.side = side;
    this.state = readyState;
  }

  get readyState(): number {
    return this.state;
  }

  send(data: string): void {
    if (this.state !== 1) {
      throw new Error("FakeWebSocket is not open.");
    }
    if (typeof data !== "string") {
      throw new TypeError("FakeWebSocket V1 accepts text frames only.");
    }
    this.sent.push(data);
    this.pair.transmit(this, data);
  }

  close(code = 1000, reason = ""): void {
    if (this.state === 2 || this.state === 3) {
      return;
    }
    this.state = 2;
    this.pair.closeFrom(this, code, reason);
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: any) => void,
  ): void {
    let listeners = this.listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener as FakeListener);
  }

  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: any) => void,
  ): void {
    this.listeners.get(type)?.delete(listener as FakeListener);
  }

  listenerCount(type?: "open" | "message" | "close" | "error"): number {
    if (type !== undefined) {
      return this.listeners.get(type)?.size ?? 0;
    }
    let count = 0;
    for (const listeners of this.listeners.values()) {
      count += listeners.size;
    }
    return count;
  }

  captureListeners(
    type: "open" | "message" | "close" | "error",
  ): Array<(event: any) => void> {
    return [...(this.listeners.get(type) ?? [])];
  }

  /** Invoke a previously captured listener even after it has been detached. */
  emitCaptured(
    listeners: ReadonlyArray<(event: any) => void>,
    type: "open" | "message" | "close" | "error",
    init: Omit<FakeEvent, "type" | "target"> = {},
  ): void {
    const event: FakeEvent = { type, target: this, ...init };
    for (const listener of listeners) {
      listener(event);
    }
  }

  /** Test-only event injection; detached Transport generations will ignore it. */
  emit(type: "open" | "message" | "close" | "error", init: Omit<FakeEvent, "type" | "target"> = {}): void {
    const event: FakeEvent = { type, target: this, ...init };
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  setReadyState(state: number): void {
    this.state = state;
  }
}

/**
 * In-memory full-duplex WebSocket pair with one-shot loss/delay/duplication
 * rules. Delivery uses the supplied protocol clock's microtask queue.
 */
export class FakeWebSocketPair {
  readonly client: FakeWebSocket;
  readonly server: FakeWebSocket;

  private readonly clock: ProtocolClock;
  private readonly rules: OneShotRule[] = [];
  private interceptor: FakeWebSocketInterceptor | undefined;
  private packetSequence = 0;
  private closeScheduled = false;
  private readonly synchronousDelivery: boolean;

  constructor(options: FakeWebSocketPairOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.synchronousDelivery = options.synchronousDelivery === true;
    const readyState = options.autoOpen === false ? 0 : 1;
    this.client = new FakeWebSocket(this, "client", readyState);
    this.server = new FakeWebSocket(this, "server", readyState);
  }

  open(): void {
    for (const socket of [this.client, this.server]) {
      if (socket.readyState === 0) {
        socket.setReadyState(1);
        this.clock.queueMicrotask(() => socket.emit("open"));
      }
    }
  }

  disconnect(code = 1006, reason = "Disconnected", wasClean = false): void {
    this.finishClose(code, reason, wasClean);
  }

  setInterceptor(interceptor: FakeWebSocketInterceptor | undefined): void {
    this.interceptor = interceptor;
  }

  dropNext(match: FakePacketMatch = {}): void {
    this.rules.push({ match, directive: { drop: true } });
  }

  delayNext(delayMs: number, match: FakePacketMatch = {}): void {
    this.rules.push({ match, directive: { delayMs } });
  }

  duplicateNext(copies = 2, match: FakePacketMatch = {}): void {
    if (!Number.isSafeInteger(copies) || copies < 2) {
      throw new RangeError("copies must be an integer of at least 2.");
    }
    this.rules.push({ match, directive: { copies } });
  }

  synchronouslyNext(match: FakePacketMatch = {}): void {
    this.rules.push({ match, directive: { synchronous: true } });
  }

  failNextSend(
    match: FakePacketMatch = {},
    error: unknown = new Error("Injected FakeWebSocket.send failure."),
  ): void {
    this.rules.push({ match, directive: { throwError: error } });
  }

  socketFactory(side: FakeWebSocketSide = "client"): WebSocketFactory {
    const socket = side === "client" ? this.client : this.server;
    let used = false;
    return () => {
      if (used) {
        throw new Error("FakeWebSocketPair socket factory can only be used once.");
      }
      used = true;
      return socket;
    };
  }

  transmit(fromSocket: FakeWebSocket, data: string): void {
    const from = fromSocket.side;
    const to: FakeWebSocketSide = from === "client" ? "server" : "client";
    const direction: FakeWebSocketDirection =
      from === "client" ? "client-to-server" : "server-to-client";
    const packet: FakeWebSocketPacket = {
      from,
      to,
      direction,
      data,
      kind: parseFrameKind(data),
      sequence: ++this.packetSequence,
    };

    const ruleIndex = this.rules.findIndex((rule) => matches(packet, rule.match));
    const rule = ruleIndex < 0 ? undefined : this.rules.splice(ruleIndex, 1)[0];
    const directive = this.interceptor?.(packet) ?? rule?.directive ?? {};
    if (directive.throwError !== undefined) {
      throw directive.throwError;
    }
    if (directive.drop === true) {
      return;
    }
    const copies = normalizeCopies(directive.copies);
    const target = to === "client" ? this.client : this.server;
    for (let copy = 0; copy < copies; copy += 1) {
      const deliver = () => {
        if (target.readyState !== 3) {
          target.emit("message", { data });
        }
      };
      const delayMs = directive.delayMs ?? 0;
      if (delayMs > 0) {
        this.clock.setTimeout(deliver, delayMs);
      } else if (directive.synchronous === true || this.synchronousDelivery) {
        deliver();
      } else {
        this.clock.queueMicrotask(deliver);
      }
    }
  }

  closeFrom(_socket: FakeWebSocket, code: number, reason: string): void {
    if (this.closeScheduled) {
      return;
    }
    this.closeScheduled = true;
    if (this.synchronousDelivery) {
      this.finishClose(code, reason, true);
    } else {
      this.clock.queueMicrotask(() => {
        this.finishClose(code, reason, true);
      });
    }
  }

  private finishClose(code: number, reason: string, wasClean: boolean): void {
    const sockets = [this.client, this.server] as const;
    for (const socket of sockets) {
      socket.setReadyState(3);
    }
    for (const socket of sockets) {
      if (this.synchronousDelivery) {
        socket.emit("close", { code, reason, wasClean });
      } else {
        this.clock.queueMicrotask(() => {
          socket.emit("close", { code, reason, wasClean });
        });
      }
    }
  }
}

/** A reconnect-capable factory that consumes the supplied sockets in order. */
export function socketFactoryFrom(
  ...sockets: WebSocketLike[]
): WebSocketFactory {
  let index = 0;
  return () => {
    const socket = sockets[index++];
    if (socket === undefined) {
      throw new Error("No FakeWebSocket remains in this factory.");
    }
    return socket;
  };
}

function parseFrameKind(data: string): FakeTransportFrameKind | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed === null || typeof parsed !== "object" || !("kind" in parsed)) {
      return undefined;
    }
    const kind = (parsed as { kind: unknown }).kind;
    return kind === "DATA" ||
      kind === "ACK" ||
      kind === "CLOSE" ||
      kind === "CLOSE_ACK"
      ? kind
      : undefined;
  } catch {
    return undefined;
  }
}

function matches(packet: FakeWebSocketPacket, match: FakePacketMatch): boolean {
  return (
    (match.direction === undefined || packet.direction === match.direction) &&
    (match.kind === undefined || packet.kind === match.kind)
  );
}

function normalizeCopies(copies: number | undefined): number {
  if (copies === undefined) {
    return 1;
  }
  return Number.isSafeInteger(copies) && copies >= 1 ? copies : 1;
}
