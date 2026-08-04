import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const packageName = "@remote-input/pc-agent";
const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.resolve(agentDir, "../..");
const releaseDir = path.join(agentDir, "release");
const runtimeCacheDir = path.join(releaseDir, ".runtime-cache");
const platform = normalizePlatform(process.platform);
const arch = normalizeArch(process.arch);
const artifactName = `remote-input-${platform}-${arch}`;
const artifactDir = path.join(releaseDir, artifactName);
const appDir = path.join(artifactDir, "app");
const runtimeDir = path.join(artifactDir, "runtime");
const nodeVersion = process.env.REMOTE_INPUT_NODE_VERSION || process.versions.node;
const archiveExtension = platform === "win" ? "zip" : "tar.xz";
const distributionName = `node-v${nodeVersion}-${platform}-${arch}`;
const archiveName = `${distributionName}.${archiveExtension}`;
const officialDownloadBase = `https://nodejs.org/dist/v${nodeVersion}`;
const runtimeDownloadBase = process.env.REMOTE_INPUT_NODE_MIRROR
  ? `${process.env.REMOTE_INPUT_NODE_MIRROR.replace(/\/+$/, "")}/v${nodeVersion}`
  : officialDownloadBase;
const temporaryDir = mkdtempSync(path.join(tmpdir(), "remote-input-package-"));

try {
  resetArtifactDirectory();
  deployApplication();
  writeDeployedManifest();
  installNodeRuntime();
  writeLaunchers();
  writeBundleReadme();
  verifyPortableArtifact();
  console.log(`Portable PC Agent created at ${artifactDir}`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}

function resetArtifactDirectory() {
  if (path.dirname(artifactDir) !== releaseDir || !artifactName.startsWith("remote-input-")) {
    throw new Error(`Refusing to replace unexpected path: ${artifactDir}`);
  }
  rmSync(artifactDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });
}

function deployApplication() {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  execFileSync(
    pnpm,
    ["--filter", packageName, "deploy", "--prod", appDir],
    { cwd: workspaceDir, stdio: "inherit" },
  );
}

function writeDeployedManifest() {
  const sourceManifest = JSON.parse(readFileSync(path.join(agentDir, "package.json"), "utf8"));
  writeFileSync(
    path.join(appDir, "package.json"),
    `${JSON.stringify({
      name: sourceManifest.name,
      version: sourceManifest.version,
      private: true,
      type: "module",
      main: "./dist/main.js",
    }, null, 2)}\n`,
  );
}

function installNodeRuntime() {
  mkdirSync(runtimeCacheDir, { recursive: true });
  const archivePath = path.join(runtimeCacheDir, archiveName);
  const checksumsPath = path.join(temporaryDir, "SHASUMS256.txt");
  download(`${officialDownloadBase}/SHASUMS256.txt`, checksumsPath);
  if (existsSync(archivePath)) {
    try {
      verifyChecksum(archivePath, checksumsPath);
      console.log(`Using cached ${archiveName}`);
    } catch {
      rmSync(archivePath, { force: true });
    }
  }
  if (!existsSync(archivePath)) {
    download(`${runtimeDownloadBase}/${archiveName}`, archivePath);
  }
  verifyChecksum(archivePath, checksumsPath);

  if (platform === "win") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1]",
        archivePath,
        temporaryDir,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("tar", ["-xJf", archivePath, "-C", temporaryDir], {
      stdio: "inherit",
    });
  }

  const extractedDir = path.join(temporaryDir, distributionName);
  const sourceNode = path.join(
    extractedDir,
    ...(platform === "win" ? ["node.exe"] : ["bin", "node"]),
  );
  const targetNode = path.join(runtimeDir, platform === "win" ? "node.exe" : "node");
  if (!existsSync(sourceNode)) throw new Error(`Node executable is missing: ${sourceNode}`);
  copyFileSync(sourceNode, targetNode);
  copyFileSync(path.join(extractedDir, "LICENSE"), path.join(runtimeDir, "NODE-LICENSE.txt"));
  if (platform !== "win") chmodSync(targetNode, 0o755);
}

function writeLaunchers() {
  if (platform === "win") {
    writeFileSync(path.join(artifactDir, "start.cmd"), windowsLauncher("dist\\main.js"));
    writeFileSync(
      path.join(artifactDir, "install-user-startup.cmd"),
      windowsLauncher("scripts\\user-service.mjs", "install"),
    );
    writeFileSync(
      path.join(artifactDir, "uninstall-user-startup.cmd"),
      windowsLauncher("scripts\\user-service.mjs", "uninstall"),
    );
    return;
  }

  const launchers = new Map([
    ["start.sh", unixLauncher("dist/main.js")],
    ["install-user-startup.sh", unixLauncher("scripts/user-service.mjs", "install")],
    ["uninstall-user-startup.sh", unixLauncher("scripts/user-service.mjs", "uninstall")],
  ]);
  if (platform === "darwin") launchers.set("start.command", unixLauncher("dist/main.js"));
  for (const [name, contents] of launchers) {
    const launcherPath = path.join(artifactDir, name);
    writeFileSync(launcherPath, contents);
    chmodSync(launcherPath, 0o755);
  }
}

function writeBundleReadme() {
  const start = platform === "win"
    ? "Double-click start.cmd"
    : platform === "darwin"
      ? "Double-click start.command, or run ./start.sh"
      : "Run ./start.sh";
  writeFileSync(
    path.join(artifactDir, "README.txt"),
    `Remote Input PC Agent\n\n${start}.\nThen open http://localhost:17888/receive/ in a browser.\n\nThis package includes Node.js v${nodeVersion}; no system Node.js installation is required.\nKeep the whole directory together. If you move it after installing user startup, uninstall startup first and install it again from the new location.\n`,
  );
}

function verifyPortableArtifact() {
  const runtimeNode = path.join(runtimeDir, platform === "win" ? "node.exe" : "node");
  const requiredFiles = [
    runtimeNode,
    path.join(runtimeDir, "NODE-LICENSE.txt"),
    path.join(appDir, "dist", "main.js"),
    path.join(appDir, "dist", "public", "receive", "index.html"),
    path.join(appDir, "scripts", "user-service.mjs"),
  ];
  for (const requiredFile of requiredFiles) {
    if (!existsSync(requiredFile)) throw new Error(`Portable artifact is missing: ${requiredFile}`);
  }

  const bundledVersion = execFileSync(runtimeNode, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (bundledVersion !== `v${nodeVersion}`) {
    throw new Error(`Expected Node v${nodeVersion}, received ${bundledVersion}`);
  }

  execFileSync(
    runtimeNode,
    [
      "--eval",
      "const { createRequire } = require('node:module'); const path = require('node:path'); createRequire(path.join(process.cwd(), 'package.json'))('node-hid');",
    ],
    { cwd: appDir, stdio: "inherit" },
  );
  console.log(`Verified bundled Node ${bundledVersion} and node-hid.`);
}

function windowsLauncher(entry, argument) {
  const suffix = argument ? ` ${argument}` : " %*";
  return `@echo off\r\nsetlocal\r\nset "REMOTE_INPUT_DIR=%~dp0"\r\n"%REMOTE_INPUT_DIR%runtime\\node.exe" "%REMOTE_INPUT_DIR%app\\${entry}"${suffix}\r\n`;
}

function unixLauncher(entry, argument) {
  const suffix = argument ? ` ${argument}` : ' "$@"';
  return `#!/bin/sh\nset -eu\nREMOTE_INPUT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$REMOTE_INPUT_DIR/runtime/node" "$REMOTE_INPUT_DIR/app/${entry}"${suffix}\n`;
}

function download(url, destination) {
  console.log(`Downloading ${url}`);
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $args[0] -OutFile $args[1]",
        url,
        destination,
      ],
      { stdio: "inherit" },
    );
    return;
  }
  execFileSync(
    "curl",
    [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--http1.1",
      "--retry",
      "5",
      "--retry-delay",
      "1",
      "--retry-all-errors",
      "--continue-at",
      "-",
      "--output",
      destination,
      url,
    ],
    { stdio: "inherit" },
  );
}

function verifyChecksum(archivePath, checksumsPath) {
  const checksums = readFileSync(checksumsPath, "utf8");
  const escapedName = archiveName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expected = checksums.match(new RegExp(`^([a-f0-9]{64})  ${escapedName}$`, "m"))?.[1];
  if (!expected) throw new Error(`No checksum found for ${archiveName}`);
  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${archiveName}`);
}

function normalizePlatform(value) {
  if (value === "win32") return "win";
  if (value === "darwin" || value === "linux") return value;
  throw new Error(`Unsupported packaging platform: ${value}`);
}

function normalizeArch(value) {
  if (value === "x64" || value === "arm64") return value;
  throw new Error(`Unsupported packaging architecture: ${value}`);
}
