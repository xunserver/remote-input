import assert from "node:assert/strict";
import test from "node:test";

import {
  createConsoleProtocolTracer,
  parseProtocolTraceLevel,
} from "../dist/index.js";
import { queueProtocolTrace } from "../dist/trace.js";

test("protocol trace level parser supports explicit off, summary, and chunks", () => {
  for (const value of [undefined, "", "0", "false", "off"]) {
    assert.equal(parseProtocolTraceLevel(value), undefined);
  }
  for (const value of ["1", "true", "summary"]) {
    assert.equal(parseProtocolTraceLevel(value), "summary");
  }
  assert.equal(parseProtocolTraceLevel("chunks"), "chunks");
  assert.throws(
    () => parseProtocolTraceLevel("verbose"),
    /Protocol trace level must be/,
  );
});

test("console protocol tracer prints ordered Chinese summary markers", () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    const trace = createConsoleProtocolTracer("客户端/运行-1");
    trace({
      at: 10,
      layer: "session",
      event: "request.pending",
      details: { requestId: 1, pendingCount: 1 },
    });
    trace({
      at: 11,
      layer: "transport",
      event: "transfer.queued",
      details: { transferId: 1, chunkCount: 252 },
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(lines, [
    "[协议][客户端/运行-1][0001][t=10][会话层][request.pending] 请求已加入 PendingMap：请求ID=1，Pending数量=1",
    "[协议][客户端/运行-1][0002][t=11][传输层][transfer.queued] 消息进入发送队列：传输ID=1，chunk总数=252",
  ]);
  assert.ok(lines.every((line) => !line.includes("payload")));
});

test("console protocol tracer explains chunk and ACK flow in Chinese", () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    const trace = createConsoleProtocolTracer("客户端/运行-1");
    trace({
      at: 20,
      layer: "transport",
      event: "chunk.send",
      details: {
        generation: 1,
        transferId: 7,
        chunkIndex: 0,
        chunkCount: 3,
        attempt: 2,
        frameBytes: 128,
        inFlightChunks: 2,
        window: 4,
      },
    });
    trace({
      at: 21,
      layer: "transport",
      event: "chunk.received",
      details: {
        generation: 1,
        transferId: 7,
        chunkIndex: 0,
        chunkCount: 3,
        chunkBytes: 60,
      },
    });
    trace({
      at: 22,
      layer: "transport",
      event: "chunk.cached",
      details: {
        generation: 1,
        transferId: 7,
        chunkIndex: 0,
        chunkCount: 3,
        receivedChunks: 1,
        totalPayloadBytes: 60,
      },
    });
    trace({
      at: 23,
      layer: "transport",
      event: "ack.send",
      details: {
        generation: 1,
        transferId: 7,
        chunkIndex: 0,
        chunkCount: 3,
      },
    });
    trace({
      at: 24,
      layer: "transport",
      event: "chunk.ack.received",
      details: {
        generation: 1,
        transferId: 7,
        chunkIndex: 0,
        chunkCount: 3,
        attempt: 2,
        acknowledgedChunks: 1,
      },
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(lines, [
    "[协议][客户端/运行-1][0001][t=20][传输层][chunk.send] 尝试发送 chunk 1/3：传输ID=7，第2次尝试，完整DATA帧=128B，窗口占用=2/4，连接代次=1",
    "[协议][客户端/运行-1][0002][t=21][传输层][chunk.received] 收到 chunk 1/3：传输ID=7，内容=60B，连接代次=1",
    "[协议][客户端/运行-1][0003][t=22][传输层][chunk.cached] 暂存 chunk 1/3：传输ID=7，已暂存=1/3，累计内容=60B，连接代次=1",
    "[协议][客户端/运行-1][0004][t=23][传输层][ack.send] 尝试发送 chunk 1/3 的 ACK：传输ID=7，连接代次=1",
    "[协议][客户端/运行-1][0005][t=24][传输层][chunk.ack.received] 收到 chunk 1/3 的 ACK：传输ID=7，已确认=1/3，ACK到达时累计发送=2次，连接代次=1",
  ]);
});

test("trace observers cannot escape through sync or async failures", async () => {
  let calls = 0;
  const event = {
    at: 0,
    layer: "transport",
    event: "state.changed",
    details: { state: "connected" },
  };

  queueProtocolTrace(() => {
    calls += 1;
    throw new Error("sync observer failure");
  }, event);
  queueProtocolTrace(async () => {
    calls += 1;
    throw new Error("async observer failure");
  }, event);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});
