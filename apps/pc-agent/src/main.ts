import http from "node:http";
import { HID, devicesAsync, type Device } from "node-hid";
import {
  runAgentRuntime,
  type HidConnector,
  type ReconnectableHidChannel,
} from "./agent-runtime.js";
import { getConfig } from "./config.js";
import { createHttpHandler } from "./http/http-handler.js";
import { createInputProcessor } from "./input/input-processor.js";
import { InputQueue } from "./input/input-queue.js";
import { createInputService } from "./input/input-service.js";
import { MessageStore } from "./messages/message-store.js";
import { getLanAddresses } from "./network.js";
import { RuntimeStatusStore } from "./status/runtime-status.js";
import { RemoteWebSocketServer } from "./websocket/protocol-server.js";

const config = getConfig();
const messages = new MessageStore(100);
const runtimeStatus = new RuntimeStatusStore();
const inputQueue = new InputQueue(
  messages,
  createInputProcessor(config.inputMode),
);
const acceptText = createInputService(messages, inputQueue);
const abortController = new AbortController();
const httpHandler = createHttpHandler(config, messages, runtimeStatus);
const server = http.createServer((req, res) => {
  httpHandler.handle(req, res).catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: "Internal server error" }));
  });
});
const protocolServer = new RemoteWebSocketServer({
  server,
  acceptText,
  runtimeStatus,
  ...(config.protocolTraceLevel === undefined
    ? {}
    : { protocolTraceLevel: config.protocolTraceLevel }),
});
const connector = createHidConnector(config.vendorId, config.productId);
const hidRuntime = runAgentRuntime({
  connector,
  processText: (text) => acceptText("hid", text),
  signal: abortController.signal,
  onStateChange: (state, deviceName) => {
    runtimeStatus.setHid(state, deviceName);
  },
});

server.listen(config.port, config.host, () => {
  console.log(`Remote Copy PC Agent is running on port ${config.port}.`);
  console.log(
    config.inputMode === "paste"
      ? "Input mode: paste (clipboard writes and system paste are enabled)."
      : "Input mode: dev (received text is only printed).",
  );
  console.log(
    `HID: ${hex(config.vendorId)}:${hex(config.productId)} (auto reconnect enabled).`,
  );
  console.log(`Local:   http://localhost:${config.port}`);
  for (const address of getLanAddresses()) {
    console.log(`LAN:     http://${address}:${config.port}`);
  }
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch((error: unknown) => {
      console.error("Failed to shut down PC Agent cleanly:", error);
      process.exitCode = 1;
    });
  });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  abortController.abort();
  httpHandler.close();
  await Promise.allSettled([
    protocolServer.close(),
    closeHttpServer(server),
    hidRuntime,
  ]);
}

function createHidConnector(
  vendorId: number,
  productId: number,
): HidConnector {
  return {
    async open() {
      const descriptor = selectRelayInterface(
        await devicesAsync(vendorId, productId),
      );
      if (!descriptor?.path) return null;
      const device = new HID(descriptor.path);
      const channel: ReconnectableHidChannel = {
        deviceName: descriptor.product ?? "Remote Copy ESP32-S3",
        onData(listener) {
          const handler = (data: Buffer) => listener(new Uint8Array(data));
          device.on("data", handler);
          return () => device.off("data", handler);
        },
        onError(listener) {
          device.once("error", listener);
        },
        write(report) {
          device.write([0, ...report]);
        },
        close() {
          try {
            device.close();
          } catch {
            // The operating system may already have removed the device.
          }
        },
      };
      return channel;
    },
  };
}

export function selectRelayInterface(devices: Device[]): Device | undefined {
  return devices.find((device) => device.usagePage === 0xff00 && device.path)
    ?? devices.find((device) => Boolean(device.path));
}

function closeHttpServer(serverToClose: http.Server): Promise<void> {
  if (!serverToClose.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    serverToClose.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function hex(value: number): string {
  return value.toString(16).padStart(4, "0");
}
