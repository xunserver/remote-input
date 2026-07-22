import path from "node:path";
import { cp, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDist = path.resolve(packageDir, "../client/dist");
const serverPublic = path.resolve(packageDir, "dist/public");

try {
  if (!(await stat(path.join(clientDist, "index.html"))).isFile()) {
    throw new Error("index.html is not a file");
  }
} catch {
  throw new Error(
    `Client build output is missing at ${clientDist}. Build @remote-copy/client first.`,
  );
}

await rm(serverPublic, { force: true, recursive: true });
await cp(clientDist, serverPublic, { recursive: true });
