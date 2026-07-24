import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderLinuxUnit, renderMacPlist, renderWindowsLauncher } from "./service-config.mjs";

const action = process.argv[2];
if (action !== "install" && action !== "uninstall") {
  throw new Error("Usage: user-service.mjs <install|uninstall>");
}

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(agentDir, "dist", "main.js");
const node = process.execPath;

if (process.platform === "linux") configureLinux();
else if (process.platform === "darwin") configureMac();
else if (process.platform === "win32") configureWindows();
else throw new Error(`Unsupported platform: ${process.platform}`);

console.log(`Remote Copy agent user startup ${action === "install" ? "installed" : "removed"}.`);

function configureLinux() {
  const unitDir = path.join(homedir(), ".config", "systemd", "user");
  const unit = path.join(unitDir, "remote-copy-agent.service");
  if (action === "uninstall") {
    runOptional("systemctl", ["--user", "disable", "--now", "remote-copy-agent.service"]);
    rmSync(unit, { force: true });
    runOptional("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unit, renderLinuxUnit(node, entry));
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", "remote-copy-agent.service"]);
}

function configureMac() {
  const launchDir = path.join(homedir(), "Library", "LaunchAgents");
  const plist = path.join(launchDir, "com.remote-copy.agent.plist");
  const domain = `gui/${process.getuid()}`;
  if (action === "uninstall") {
    runOptional("launchctl", ["bootout", domain, plist]);
    rmSync(plist, { force: true });
    return;
  }
  const logDir = path.join(homedir(), "Library", "Logs", "RemoteCopy");
  mkdirSync(launchDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(plist, renderMacPlist(node, entry, path.join(logDir, "agent.log"), path.join(logDir, "agent-error.log")));
  runOptional("launchctl", ["bootout", domain, plist]);
  run("launchctl", ["bootstrap", domain, plist]);
}

function configureWindows() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA is unavailable.");
  const installDir = path.join(appData, "RemoteCopy");
  const launcher = path.join(installDir, "agent.ps1");
  const pidFile = path.join(installDir, "agent.pid");
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  if (action === "uninstall") {
    runOptional("reg.exe", ["delete", key, "/v", "RemoteCopyAgent", "/f"]);
    try {
      const pid = readFileSync(pidFile, "utf8").trim();
      if (/^[1-9][0-9]*$/.test(pid)) runOptional("taskkill.exe", ["/PID", pid, "/T", "/F"]);
    } catch { /* No running installed agent. */ }
    rmSync(installDir, { recursive: true, force: true });
    return;
  }
  mkdirSync(installDir, { recursive: true });
  writeFileSync(launcher, renderWindowsLauncher(node, entry, pidFile));
  const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcher}"`;
  run("reg.exe", ["add", key, "/v", "RemoteCopyAgent", "/t", "REG_SZ", "/d", command, "/f"]);
  spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", launcher], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function run(command, args) { execFileSync(command, args, { stdio: "inherit" }); }
function runOptional(command, args) { try { run(command, args); } catch { /* Missing previous service is expected. */ } }
