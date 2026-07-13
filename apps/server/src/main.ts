import http from "node:http";
import { getConfig } from "./config";
import { createStaticHandler } from "./http/staticServer";
import { InputQueue } from "./input/inputQueue";
import { getLanAddresses } from "./network";
import { RemoteWebSocketServer } from "./ws/webSocketServer";

const config = getConfig();
const inputQueue = new InputQueue();

let wsServer: RemoteWebSocketServer;

const server = http.createServer((req, res) => {
  createStaticHandler(config, () => wsServer.getClientCount())(req, res).catch((error) => {
    console.error(error);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  });
});

wsServer = new RemoteWebSocketServer({
  server,
  config,
  onInput: (client, requestId, text) => {
    inputQueue.enqueue({ client, requestId, text });
  },
});

server.listen(config.port, config.host, () => {
  console.log(`Remote input server is running on port ${config.port}.`);
  console.log(`Local:   http://localhost:${config.port}`);

  for (const address of getLanAddresses()) {
    console.log(`LAN:     http://${address}:${config.port}`);
  }
});
