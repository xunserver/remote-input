export type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

export interface ProtocolClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
  queueMicrotask(callback: () => void): void;
}

export const systemClock: ProtocolClock = {
  now: () => globalThis.performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
};
