import type { ConnectionConfig } from "@/types/remote-input";

export const connectionStorageKey = "remote-input.connection-url";
export const connectionMethodStorageKey = "remote-input.connection-method";

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
    const url = new URL(/^(?:https?|wss?):\/\//i.test(value) ? value : `http://${value}`);
    return {
      host: url.hostname || fallback.host,
      port: url.port,
      secure: url.protocol === "https:" || url.protocol === "wss:",
    };
  } catch {
    return fallback;
  }
}

export function buildWebSocketUrl(config: ConnectionConfig): string {
  const fallback = getDefaultConnectionConfig();
  const rawHost = config.host.trim() || fallback.host;
  let host = rawHost;
  let port = config.port.trim();
  let secure = config.secure;

  try {
    const parsed = new URL(/^(?:https?|wss?):\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`);
    host = parsed.hostname;
    port = port || parsed.port;
    secure = /^(?:https?|wss?):\/\//i.test(rawHost)
      ? parsed.protocol === "https:" || parsed.protocol === "wss:"
      : secure;
  } catch {
    host = rawHost.replace(/^(?:https?|wss?):\/\//i, "").replace(/\/.*$/, "");
  }

  const protocol = secure ? "wss:" : "ws:";
  const authorityHost =
    host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
  const authority = port ? authorityHost + ":" + port : authorityHost;
  return protocol + "//" + authority + "/ws";
}
