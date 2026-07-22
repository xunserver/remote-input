import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseProtocolTraceLevel,
  type ProtocolTraceLevel,
} from "@remote-copy/protocol";
import type { InputMode } from "./input/inputProcessor.js";

export type AppConfig = {
  host: string;
  port: number;
  publicDir: string;
  inputMode: InputMode;
  protocolTraceLevel: ProtocolTraceLevel | undefined;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return {
    host: env.HOST || "0.0.0.0",
    port: Number(env.PORT || 17888),
    publicDir: path.resolve(currentDir, "public"),
    inputMode: getInputMode(env.INPUT_MODE),
    protocolTraceLevel: parseProtocolTraceLevel(env.PROTOCOL_DEBUG),
  };
}

function getInputMode(value: string | undefined): InputMode {
  const mode = value ?? "paste";
  if (mode === "paste" || mode === "dev") {
    return mode;
  }
  throw new Error(`INPUT_MODE must be "paste" or "dev"; received ${JSON.stringify(value)}.`);
}
