import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseProtocolTraceLevel,
  type ProtocolTraceLevel,
} from "@remote-copy/protocol";
import type { InputMode } from "./input/input-processor.js";

export type AppConfig = {
  host: string;
  port: number;
  publicDir: string;
  inputMode: InputMode;
  protocolTraceLevel: ProtocolTraceLevel | undefined;
  vendorId: number;
  productId: number;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return {
    host: env.HOST || "0.0.0.0",
    port: parsePort(env.PORT),
    publicDir: path.resolve(currentDir, "public"),
    inputMode: parseInputMode(env.INPUT_MODE),
    protocolTraceLevel: parseProtocolTraceLevel(env.PROTOCOL_DEBUG),
    vendorId: parseId(env.REMOTE_COPY_VID, 0x303a),
    productId: parseId(env.REMOTE_COPY_PID, 0x4002),
  };
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 17888 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function parseInputMode(value: string | undefined): InputMode {
  const mode = value ?? "paste";
  if (mode !== "paste" && mode !== "dev") {
    throw new Error('INPUT_MODE must be "paste" or "dev".');
  }
  return mode;
}

function parseId(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
    throw new Error("VID/PID must be a 16-bit integer.");
  }
  return parsed;
}
