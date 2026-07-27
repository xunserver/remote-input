import path from "node:path";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const publicDir = path.join(packageDir, "dist/public");
const builds = [
  ["Client", path.resolve(packageDir, "../client/dist"), "."],
  ["Receiver", path.resolve(packageDir, "../receiver/dist"), "receive"],
  ["WebHID agent", path.resolve(packageDir, "../web-agent/dist"), "webhid"],
];

for (const [name, output] of builds) {
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

await rm(publicDir, { force: true, recursive: true });
await mkdir(publicDir, { recursive: true });
for (const [, output, destination] of builds) {
  await cp(output, path.join(publicDir, destination), { recursive: true });
}
