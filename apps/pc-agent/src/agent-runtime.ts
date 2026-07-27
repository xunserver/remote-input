import {
  RelayAgent,
  type HidChannel,
  type TextProcessor,
} from "@remote-copy/web-agent-sdk";

export interface ReconnectableHidChannel extends HidChannel {
  deviceName?: string;
  onError(listener: (error: unknown) => void): void;
  close(): void;
}

export interface HidConnector {
  open(): Promise<ReconnectableHidChannel | null>;
}

export interface AgentRuntimeOptions {
  connector: HidConnector;
  processText: TextProcessor;
  signal: AbortSignal;
  retryMs?: number;
  log?: (message: string) => void;
  onError?: (error: unknown) => void;
  onStateChange?: (
    state: "waiting" | "connected" | "disconnected",
    deviceName?: string,
  ) => void;
}

/** Keeps the user-session agent alive across device absence and USB reconnects. */
export async function runAgentRuntime(options: AgentRuntimeOptions): Promise<void> {
  const retryMs = options.retryMs ?? 1_000;
  const log = options.log ?? console.log;
  const onError = options.onError ?? console.error;
  let waitingLogged = false;

  while (!options.signal.aborted) {
    let channel: ReconnectableHidChannel | null = null;
    try {
      channel = await options.connector.open();
    } catch (error) {
      onError(error);
    }
    if (!channel) {
      if (!waitingLogged) {
        log("Waiting for the Remote Copy ESP32-S3 HID device...");
        options.onStateChange?.("waiting");
        waitingLogged = true;
      }
      await abortableDelay(retryMs, options.signal);
      continue;
    }

    waitingLogged = false;
    log("Remote Copy ESP32-S3 connected.");
    options.onStateChange?.("connected", channel.deviceName);
    const disconnected = new Promise<void>((resolve) => channel?.onError((error) => {
      onError(error);
      resolve();
    }));
    const agent = new RelayAgent(channel, options.processText, onError);
    await Promise.race([disconnected, waitForAbort(options.signal)]);
    agent.close();
    channel.close();
    if (!options.signal.aborted) {
      log("Remote Copy ESP32-S3 disconnected; reconnecting...");
      options.onStateChange?.("disconnected");
      await abortableDelay(retryMs, options.signal);
    }
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
