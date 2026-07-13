import path from "node:path";

export type AppConfig = {
  host: string;
  port: number;
  publicDir: string;
};

export function getConfig(): AppConfig {
  return {
    host: process.env.HOST || "0.0.0.0",
    port: Number(process.env.PORT || 17888),
    publicDir: path.resolve(__dirname, "..", "..", "..", "public"),
  };
}
