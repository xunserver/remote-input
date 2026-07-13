import type { ConnectionConfig } from "@/types/remote-input";

export const connectionStorageKey = "remote-copy.connection-url";

export function getDefaultConnectionConfig(): ConnectionConfig {
  if (typeof window === "undefined") {
    return { host: "localhost", port: "3000", secure: false };
  }

  return {
    host: window.location.hostname || "localhost",
    port: window.location.port,
    secure: window.location.protocol === "https:",
  };
}

export function getConfigFromUrl(value: string): ConnectionConfig {
  const fallback = getDefaultConnectionConfig();

  try {
    const url = new URL(/^wss?:\/\//i.test(value) ? value : `ws://${value}`);
    return {
      host: url.hostname || fallback.host,
      port: url.port,
      secure: url.protocol === "wss:",
    };
  } catch {
    return fallback;
  }
}

export function buildWsUrl(config: ConnectionConfig): string {
  const fallback = getDefaultConnectionConfig();
  const rawHost = config.host.trim() || fallback.host;
  let host = rawHost;
  let port = config.port.trim();
  let secure = config.secure;

  try {
    const parsed = new URL(/^wss?:\/\//i.test(rawHost) ? rawHost : `ws://${rawHost}`);
    host = parsed.hostname;
    port = port || parsed.port;
    secure = /^wss?:\/\//i.test(rawHost) ? parsed.protocol === "wss:" : secure;
  } catch {
    host = rawHost.replace(/^wss?:\/\//i, "").replace(/\/.*$/, "");
  }

  const protocol = secure ? "wss:" : "ws:";
  return `${protocol}//${host}${port ? `:${port}` : ""}/ws`;
}
