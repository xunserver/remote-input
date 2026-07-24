import path from "node:path";
import { cp, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDist = path.resolve(packageDir, "../client/dist");
const webAgentDist = path.resolve(packageDir, "../web-agent/dist");
const serverPublic = path.resolve(packageDir, "dist/public");

for (const [name, output] of [["Client", clientDist], ["Web agent", webAgentDist]]) {
  try {
    if (!(await stat(path.join(output, "index.html"))).isFile()) {
      throw new Error("index.html is not a file");
    }
  } catch {
    throw new Error(
      `${name} build output is missing at ${output}. Build its workspace package first.`,
    );
  }
}

await rm(serverPublic, { force: true, recursive: true });
await cp(clientDist, serverPublic, { recursive: true });
await cp(webAgentDist, path.join(serverPublic, "receive"), { recursive: true });
