import path from "node:path";
import { fileURLToPath } from "node:url";

export type AppConfig = {
  host: string;
  port: number;
  publicDir: string;
};

export function getConfig(): AppConfig {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return {
    host: process.env.HOST || "0.0.0.0",
    port: Number(process.env.PORT || 17888),
    publicDir: path.resolve(currentDir, "..", "..", "..", "public"),
  };
}
