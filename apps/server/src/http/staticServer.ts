import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import { getLanAddresses } from "../network.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath);
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };

  return contentTypes[ext] || "application/octet-stream";
}

export function createStaticHandler(config: AppConfig, getClientCount: () => number) {
  return async function handleStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/info") {
      sendJson(res, 200, {
        port: config.port,
        lanAddresses: getLanAddresses(),
        clients: getClientCount(),
      });
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(config.publicDir, safePath);

    if (!filePath.startsWith(config.publicDir)) {
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
  };
}
