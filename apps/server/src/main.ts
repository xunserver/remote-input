import http from "node:http";
import { getConfig } from "./config.js";
import { createStaticHandler } from "./http/staticServer.js";
import { InputQueue } from "./input/inputQueue.js";
import { getLanAddresses } from "./network.js";
import { RemoteWebSocketServer } from "./websocket/protocol-server.js";

const config = getConfig();
// 所有客户端共享同一队列，避免剪贴板写入和系统粘贴操作相互穿插。
const inputQueue = new InputQueue();
let protocolServer: RemoteWebSocketServer;

const staticHandler = createStaticHandler(config, () => protocolServer.getClientCount());
const server = http.createServer((req, res) => {
  staticHandler(req, res).catch((error) => {
    console.error(error);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  });
});

protocolServer = new RemoteWebSocketServer({ server, inputQueue });

server.listen(config.port, config.host, () => {
  console.log(`Remote input server is running on port ${config.port}.`);
  console.log(`Local:   http://localhost:${config.port}`);
  for (const address of getLanAddresses()) {
    console.log(`LAN:     http://${address}:${config.port}`);
  }
});
