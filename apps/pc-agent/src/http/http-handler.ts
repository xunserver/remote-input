import type http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import type {
  MessageStore,
  MessageStoreEvent,
} from "../messages/message-store.js";
import { getLanAddresses } from "../network.js";
import type {
  RuntimeStatus,
  RuntimeStatusStore,
} from "../status/runtime-status.js";

export type HttpHandler = {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
  close(): void;
};

export function createHttpHandler(
  config: AppConfig,
  messages: MessageStore,
  runtimeStatus: RuntimeStatusStore,
): HttpHandler {
  const streams = new Set<http.ServerResponse>();

  return {
    async handle(req, res) {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      );

      if (url.pathname === "/api/info" && req.method === "GET") {
        sendJson(res, 200, {
          port: config.port,
          lanAddresses: getLanAddresses(),
          clients: runtimeStatus.snapshot().websocketClients,
          hid: runtimeStatus.snapshot().hid,
          messages: messages.snapshot().length,
        });
        return;
      }
      if (url.pathname === "/api/messages" && req.method === "GET") {
        sendJson(res, 200, { messages: messages.snapshot() });
        return;
      }
      if (url.pathname === "/api/messages" && req.method === "DELETE") {
        messages.clear();
        sendJson(res, 200, { messages: [] });
        return;
      }
      if (url.pathname === "/events" && req.method === "GET") {
        openEventStream(req, res, streams, messages, runtimeStatus);
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname === "/events") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      await sendStatic(config.publicDir, url.pathname, res);
    },
    close() {
      for (const stream of streams) stream.end();
      streams.clear();
    },
  };
}

function openEventStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  streams: Set<http.ServerResponse>,
  messages: MessageStore,
  runtimeStatus: RuntimeStatusStore,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  streams.add(res);
  sendEvent(res, "snapshot", {
    messages: messages.snapshot(),
    status: runtimeStatus.snapshot(),
  });

  const unsubscribeMessages = messages.subscribe((event) => {
    sendMessageStoreEvent(res, event);
  });
  const unsubscribeStatus = runtimeStatus.subscribe((status) => {
    sendEvent(res, "status", status);
  });
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribeMessages();
    unsubscribeStatus();
    streams.delete(res);
  };
  req.once("close", close);
  res.once("close", close);
}

function sendMessageStoreEvent(
  res: http.ServerResponse,
  event: MessageStoreEvent,
): void {
  if (event.type === "message") sendEvent(res, "message", event.message);
  else sendEvent(res, "cleared", {});
}

function sendEvent(
  res: http.ServerResponse,
  event: string,
  data: RuntimeStatus | unknown,
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function sendStatic(
  publicDir: string,
  requestedPath: string,
  res: http.ServerResponse,
): Promise<void> {
  const pathname =
    requestedPath === "/"
      ? "/index.html"
      : requestedPath === "/bookmarklet" ||
          requestedPath === "/bookmarklet/"
        ? "/bookmarklet/index.html"
        : requestedPath === "/receive" || requestedPath === "/receive/"
          ? "/receive/index.html"
          : requestedPath === "/webhid" || requestedPath === "/webhid/"
            ? "/webhid/index.html"
            : requestedPath;
  const normalized = path.posix.normalize(pathname);
  if (normalized.includes("\0") || normalized.startsWith("/../")) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  const relativePath = normalized.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, relativePath);
  const relative = path.relative(publicDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": getContentType(filePath),
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

function getContentType(filePath: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  return types[path.extname(filePath)] ?? "application/octet-stream";
}
