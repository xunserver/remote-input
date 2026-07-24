import { HID, devicesAsync, type Device } from "node-hid";
import { runAgentRuntime, type HidConnector, type ReconnectableHidChannel } from "./agent-runtime.js";
import { writeClipboardAndPaste } from "./clipboard.js";

const vendorId = parseId(process.env.REMOTE_COPY_VID, 0x303a);
const productId = parseId(process.env.REMOTE_COPY_PID, 0x4002);
const mode = readInputMode(process.env.INPUT_MODE);
const abortController = new AbortController();
const processor = mode === "dev"
  ? async (text: string) => { console.log(`Received text: ${JSON.stringify(text)}`); }
  : writeClipboardAndPaste;

const connector: HidConnector = {
  async open() {
    const descriptor = selectRelayInterface(await devicesAsync(vendorId, productId));
    if (!descriptor?.path) return null;
    const device = new HID(descriptor.path);
    const channel: ReconnectableHidChannel = {
      onData(listener) {
        const handler = (data: Buffer) => listener(new Uint8Array(data));
        device.on("data", handler);
        return () => device.off("data", handler);
      },
      onError(listener) { device.once("error", listener); },
      write(report) { device.write([0, ...report]); },
      close() { try { device.close(); } catch { /* Device may already be gone. */ } },
    };
    return channel;
  },
};

console.log(`Remote Copy v2 agent started for HID ${hex(vendorId)}:${hex(productId)} (${mode}).`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abortController.abort());
await runAgentRuntime({ connector, processText: processor, signal: abortController.signal });

export function selectRelayInterface(devices: Device[]): Device | undefined {
  return devices.find((device) => device.usagePage === 0xff00 && device.path)
    ?? devices.find((device) => Boolean(device.path));
}

function readInputMode(value: string | undefined): "paste" | "dev" {
  const mode = value ?? "paste";
  if (mode !== "paste" && mode !== "dev") throw new Error('INPUT_MODE must be "paste" or "dev".');
  return mode;
}
function parseId(value: string | undefined, fallback: number): number { const parsed = value ? Number(value) : fallback; if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) throw new Error("VID/PID must be a 16-bit integer."); return parsed; }
function hex(value: number): string { return value.toString(16).padStart(4, "0"); }
