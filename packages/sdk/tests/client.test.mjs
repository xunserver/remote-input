import assert from "node:assert/strict";
import test from "node:test";
import {
  Client,
  DEFAULT_REQUEST_TIMEOUT_MS,
  SDKError,
} from "../dist/index.js";

class TestTransport {
  receiver = null;
  sent = [];
  closeCount = 0;

  bind(receiver) {
    if (this.receiver && this.receiver !== receiver) {
      throw new Error("already bound");
    }
    this.receiver = receiver;
  }

  unbind(receiver) {
    if (this.receiver === receiver) {
      this.receiver = null;
    }
  }

  connect() {
    return Promise.resolve();
  }

  send(message, options) {
    this.sent.push(message);
    options?.onDeliveryChange?.("unknown");
    options?.onDeliveryChange?.("delivered");
    if (message.type === "request") {
      this.receiver?.accept({
        type: "response",
        requestId: message.requestId,
        ok: true,
        data: { echoed: message.payload },
      });
    }
    return Promise.resolve();
  }

  close() {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

test("sendText maps to the documented request shape", async () => {
  const transport = new TestTransport();
  const client = new Client({ transport });

  assert.deepEqual(await client.sendText("hello"), {
    echoed: {
      text: "hello",
      control: { paste: true, restoreClipboard: false },
    },
  });
  assert.deepEqual(transport.sent[0], {
    type: "request",
    requestId: 1,
    method: "sendText",
    payload: {
      text: "hello",
      control: { paste: true, restoreClipboard: false },
    },
  });
});

test("sendTextUnconfirmed completes after Transport.send without waiting for a Response", async () => {
  const transport = new TestTransport();
  transport.send = (message, options) => {
    transport.sent.push(message);
    options?.onDeliveryChange?.("unknown");
    return Promise.resolve();
  };
  const client = new Client({ transport });

  await client.sendTextUnconfirmed("hello over BLE");
  assert.deepEqual(transport.sent, [{
    type: "notify",
    method: "sendText",
    payload: {
      text: "hello over BLE",
      control: { paste: true, restoreClipboard: false },
    },
  }]);
});

test("sendText carries per-input control and inputStatus is received via notify", async () => {
  const transport = new TestTransport();
  const client = new Client({ transport });
  const statuses = [];
  client.onInputStatus((status) => statuses.push(status));

  await client.sendText("copy only", {
    operationId: "op-1",
    paste: false,
    restoreClipboard: true,
  });
  assert.deepEqual(transport.sent[0].payload, {
    text: "copy only",
    operationId: "op-1",
    control: { paste: false, restoreClipboard: true },
  });

  transport.receiver.accept({
    type: "notify",
    method: "inputStatus",
    payload: {
      operationId: "op-1",
      stage: "clipboard_restored",
      progress: 90,
      message: "restored",
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(statuses, [{
    operationId: "op-1",
    stage: "clipboard_restored",
    progress: 90,
    message: "restored",
  }]);
  assert.equal(transport.sent.length, 1);
});

test("Client forwards summary trace options to its Session without input content", async () => {
  const transport = new TestTransport();
  const events = [];
  const client = new Client({
    transport,
    traceLevel: "summary",
    onTrace: (event) => events.push(event),
  });

  await client.sendText("sdk-private-marker");
  await Promise.resolve();
  await Promise.resolve();

  const names = events.map((event) => event.event);
  assert.ok(names.includes("request.pending"));
  assert.ok(names.includes("response.received"));
  assert.ok(names.includes("request.resolved"));
  assert.equal(JSON.stringify(events).includes("sdk-private-marker"), false);
});

test("request timeout configuration rejects invalid values", () => {
  for (const requestTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new Client({ transport: new TestTransport(), requestTimeoutMs }),
      TypeError,
    );
  }
});

test("default and configured endpoint timeouts reach Transport as absolute deadlines", async () => {
  for (const requestTimeoutMs of [undefined, 1_234]) {
    const transport = new TestTransport();
    let remaining;
    transport.send = (_message, options) => {
      remaining = options.deadlineAt - performance.now();
      return new Promise(() => {});
    };
    const client = new Client({
      transport,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    });
    const expected = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const request = client.request("wait", null);
    const rejected = assert.rejects(
      request,
      (error) =>
        error instanceof SDKError &&
        error.code === "SESSION_CLOSED",
    );

    assert.ok(remaining <= expected && remaining > expected - 100);
    await client.close();
    await rejected;
  }
});

test("transport errors are not swallowed or retried", async () => {
  const expected = new SDKError(
    "TRANSPORT_QUEUE_FULL",
    "queue full",
    "not_sent",
  );
  const transport = new TestTransport();
  transport.send = () => Promise.reject(expected);
  const client = new Client({ transport });

  await assert.rejects(client.sendText("hello"), (error) => error === expected);
  assert.equal(transport.sent.length, 0);
});

test("close cascades once and permanently invalidates the old client", async () => {
  const transport = new TestTransport();
  const client = new Client({ transport });

  await Promise.all([client.close(), client.close()]);
  assert.equal(transport.closeCount, 1);
  await assert.rejects(
    client.sendText("late"),
    (error) =>
      error instanceof SDKError &&
      error.code === "SESSION_CLOSED" &&
      error.delivery === "not_sent",
  );
});

test("a reset Transport can bind a new Client without reviving the old Client", async () => {
  const transport = new TestTransport();
  const oldClient = new Client({ transport });
  await oldClient.close();

  const newClient = new Client({ transport });
  await transport.connect();
  assert.deepEqual(await newClient.sendText("new"), {
    echoed: {
      text: "new",
      control: { paste: true, restoreClipboard: false },
    },
  });
  await assert.rejects(
    oldClient.sendText("old"),
    (error) =>
      error instanceof SDKError &&
      error.code === "SESSION_CLOSED",
  );
  await newClient.close();
  assert.equal(transport.closeCount, 2);
});
