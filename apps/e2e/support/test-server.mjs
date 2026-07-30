import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const e2eDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(e2eDir, "../..");
const agentEntry = path.resolve(repositoryRoot, "apps/pc-agent/dist/main.js");
const agentURL = "http://127.0.0.1:17889/api/info";
const controlPort = 17_890;

let agentProcess = null;
let agentPaused = false;
let startingAgent = null;

const controlServer = http.createServer((request, response) => {
  void handleControlRequest(request, response).catch((error) => {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Agent control failed.",
    });
  });
});

controlServer.listen(controlPort, "127.0.0.1");
await startAgent();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit());
  });
}

async function handleControlRequest(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  if (request.url === "/start") {
    await startAgent();
  } else if (request.url === "/stop") {
    await stopAgent();
  } else if (request.url === "/pause") {
    if (!agentProcess) throw new Error("PC Agent is not running.");
    if (!agentPaused) {
      agentProcess.kill("SIGSTOP");
      agentPaused = true;
    }
  } else if (request.url === "/resume") {
    resumeAgent();
  } else {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  sendJson(response, 200, {
    paused: agentPaused,
    running: agentProcess !== null,
  });
}

function startAgent() {
  if (agentProcess) return Promise.resolve();
  if (startingAgent) return startingAgent;

  startingAgent = (async () => {
    const child = spawn(process.execPath, [agentEntry], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        INPUT_MODE: "dev",
        PORT: "17889",
      },
      stdio: "inherit",
    });
    agentProcess = child;
    agentPaused = false;
    child.once("exit", () => {
      if (agentProcess === child) {
        agentProcess = null;
        agentPaused = false;
      }
    });
    child.once("error", (error) => {
      if (agentProcess === child) agentProcess = null;
      console.error("Failed to start the E2E PC Agent:", error);
    });
    await waitForAgent();
  })().finally(() => {
    startingAgent = null;
  });

  return startingAgent;
}

async function stopAgent() {
  const child = agentProcess;
  if (!child) return;
  if (agentPaused) {
    child.kill("SIGCONT");
    agentPaused = false;
  }
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
  if (agentProcess === child) agentProcess = null;
}

function resumeAgent() {
  if (agentProcess && agentPaused) {
    agentProcess.kill("SIGCONT");
    agentPaused = false;
  }
}

async function waitForAgent() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(agentURL);
      if (response.ok) return;
    } catch {
      // The child is still binding its HTTP listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the E2E PC Agent.");
}

async function shutdown() {
  await stopAgent();
  await new Promise((resolve) => controlServer.close(resolve));
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
