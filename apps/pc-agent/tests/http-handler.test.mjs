import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHttpHandler } from "../dist/http/http-handler.js";
import { MessageStore } from "../dist/messages/message-store.js";
import { RuntimeStatusStore } from "../dist/status/runtime-status.js";

test("HTTP API serves history, status, clear, and all three web apps", async (context) => {
  const fixture = await createFixture();
  context.after(() => fixture.close());
  const message = fixture.messages.create("hid", "hello");
  fixture.messages.update(message.id, { status: "succeeded" });
  fixture.status.setHid("connected", "ESP32 Test");
  fixture.status.setWebSocketClients(2);

  const info = await getJson(`${fixture.origin}/api/info`);
  assert.equal(info.clients, 2);
  assert.deepEqual(info.hid, {
    state: "connected",
    deviceName: "ESP32 Test",
  });
  assert.equal(info.messages, 1);

  const history = await getJson(`${fixture.origin}/api/messages`);
  assert.equal(history.messages[0].text, "hello");
  assert.equal(await getText(`${fixture.origin}/`), "sender");
  assert.equal(await getText(`${fixture.origin}/receive/`), "receiver");
  assert.equal(await getText(`${fixture.origin}/webhid/`), "webhid");

  const response = await fetch(`${fixture.origin}/api/messages`, {
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.messages.snapshot(), []);
});

test("SSE sends a race-free snapshot and full message/status updates", async (context) => {
  const fixture = await createFixture();
  context.after(() => fixture.close());
  fixture.messages.create("websocket", "before-connect");

  const stream = await openStream(`${fixture.origin}/events`);
  context.after(() => stream.close());
  await stream.waitFor('event: snapshot');
  assert.match(stream.text(), /before-connect/);

  const message = fixture.messages.create("hid", "after-connect");
  fixture.messages.update(message.id, { status: "processing" });
  fixture.status.setHid("connected", "ESP32");
  await stream.waitFor('"status":"processing"');
  await stream.waitFor('event: status');
  assert.match(stream.text(), /after-connect/);
  assert.match(stream.text(), /ESP32/);

  fixture.messages.clear();
  await stream.waitFor("event: cleared");
});

async function createFixture() {
  const publicDir = await mkdtemp(path.join(os.tmpdir(), "remote-copy-http-"));
  await mkdir(path.join(publicDir, "receive"));
  await mkdir(path.join(publicDir, "webhid"));
  await writeFile(path.join(publicDir, "index.html"), "sender");
  await writeFile(path.join(publicDir, "receive/index.html"), "receiver");
  await writeFile(path.join(publicDir, "webhid/index.html"), "webhid");
  const messages = new MessageStore();
  const status = new RuntimeStatusStore();
  const config = {
    host: "127.0.0.1",
    port: 17888,
    publicDir,
    inputMode: "dev",
    protocolTraceLevel: undefined,
    vendorId: 0x303a,
    productId: 0x4002,
  };
  const handler = createHttpHandler(config, messages, status);
  const server = http.createServer((req, res) => {
    handler.handle(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    messages,
    status,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      handler.close();
      await closeServer(server);
      await rm(publicDir, { recursive: true, force: true });
    },
  };
}

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function getText(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.text();
}

function openStream(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      const waiters = [];
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        for (const waiter of [...waiters]) {
          if (body.includes(waiter.pattern)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
      });
      resolve({
        text: () => body,
        waitFor(pattern) {
          if (body.includes(pattern)) return Promise.resolve();
          return new Promise((resolveWait) => {
            waiters.push({ pattern, resolve: resolveWait });
          });
        },
        close() {
          request.destroy();
          response.destroy();
        },
      });
    });
    request.once("error", reject);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
