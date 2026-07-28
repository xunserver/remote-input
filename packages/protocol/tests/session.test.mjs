import assert from "node:assert/strict";
import test from "node:test";

import { SDKError, sdkErrorCodes } from "../dist/errors.js";
import { Session } from "../dist/session.js";

class FakeClock {
  #now = 0;
  #nextTimer = 1;
  #timers = new Map();
  #microtasks = [];

  now = () => this.#now;

  setTimeout = (callback, delayMs) => {
    const handle = this.#nextTimer++;
    this.#timers.set(handle, { callback, due: this.#now + delayMs });
    return handle;
  };

  clearTimeout = (handle) => {
    this.#timers.delete(handle);
  };

  queueMicrotask = (callback) => {
    this.#microtasks.push(callback);
  };

  setNow(now) {
    this.#now = now;
  }

  advance(ms) {
    this.#now += ms;
    this.runDueTimers();
  }

  runDueTimers() {
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.due <= this.#now)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (next === undefined) {
        return;
      }
      const [handle, timer] = next;
      this.#timers.delete(handle);
      timer.callback();
    }
  }

  flushMicrotasks() {
    while (this.#microtasks.length > 0) {
      const callbacks = this.#microtasks.splice(0);
      for (const callback of callbacks) {
        callback();
      }
    }
  }

  get timerCount() {
    return this.#timers.size;
  }
}

class MemoryTransport {
  receiver = undefined;
  sent = [];
  closeCalls = 0;
  unbindCalls = 0;
  sendImpl = undefined;
  closeImpl = undefined;

  bind(receiver) {
    if (this.receiver !== undefined && this.receiver !== receiver) {
      throw new Error("receiver already bound");
    }
    this.receiver = receiver;
  }

  unbind(receiver) {
    this.unbindCalls += 1;
    if (this.receiver === receiver) {
      this.receiver = undefined;
    }
  }

  connect() {
    return Promise.resolve();
  }

  send(message, options = {}) {
    const record = { message, options };
    this.sent.push(record);
    if (this.sendImpl !== undefined) {
      return this.sendImpl(message, options, record);
    }
    options.onDeliveryChange?.("delivered");
    return Promise.resolve();
  }

  close() {
    this.closeCalls += 1;
    return this.closeImpl?.() ?? Promise.resolve();
  }

  accept(message) {
    this.receiver?.accept(message);
  }

  disconnect(error = transportError(sdkErrorCodes.transportDisconnected, "unknown")) {
    this.receiver?.disconnected(error);
  }

  localClose() {
    this.receiver?.localClosed();
  }

  peerClose() {
    this.receiver?.peerClosed();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function transportError(code, delivery) {
  return new SDKError(code, code, delivery);
}

async function drain(clock, turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    // Transport.send rejection reactions use the native Promise queue; Session
    // scheduling uses its injected clock. This order mirrors the Transport
    // contract during disconnect.
    await Promise.resolve();
    clock.flushMicrotasks();
  }
}

async function assertSDKRejects(promise, code, delivery) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof SDKError);
    assert.equal(error.code, code);
    assert.equal(error.delivery, delivery);
    return true;
  });
}

function respond(transport, requestId, data) {
  transport.accept({ type: "response", requestId, ok: true, data });
}

test("constructor validates the default endpoint timeout", () => {
  for (const requestTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new Session(new MemoryTransport(), { requestTimeoutMs }),
      RangeError,
    );
  }
});

test("large finite timeouts are scheduled in safe chunks instead of firing early", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const session = new Session(transport, {
    clock,
    requestTimeoutMs: 1_000_000_000_000,
  });

  const result = session.request("long", null);
  clock.advance(2_147_483_647);
  await drain(clock);
  assert.equal(clock.timerCount, 1);

  respond(transport, 1, "within-deadline");
  assert.equal(await result, "within-deadline");
  assert.equal(clock.timerCount, 0);
});

test("SE-01/02: Pending exists before send and a synchronous Response settles once", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  transport.sendImpl = (message) => {
    respond(transport, message.requestId, { echoed: message.payload });
    return Promise.resolve();
  };
  const session = new Session(transport, { clock, requestTimeoutMs: 50 });

  const first = session.request("echo", "A");
  assert.deepEqual(await first, { echoed: "A" });
  assert.equal(transport.sent[0].message.requestId, 1);
  assert.equal(transport.sent[0].options.signal.aborted, true);
  assert.equal(clock.timerCount, 0);

  assert.deepEqual(await session.request("echo", "B"), { echoed: "B" });
  assert.equal(transport.sent[1].message.requestId, 2);
  assert.equal(clock.timerCount, 0);
});

test("SE-03/07/29: timeout covers the whole request and preserves all delivery stages", async () => {
  for (const delivery of ["not_sent", "unknown", "delivered"]) {
    const clock = new FakeClock();
    const transport = new MemoryTransport();
    const send = deferred();
    transport.sendImpl = (_message, options) => {
      if (delivery !== "not_sent") {
        options.onDeliveryChange(delivery);
      }
      options.signal.addEventListener("abort", () => send.reject(new Error("aborted")), {
        once: true,
      });
      return send.promise;
    };
    const session = new Session(transport, { clock, requestTimeoutMs: 10 });

    const result = session.request("slow", null);
    clock.advance(10);
    await assertSDKRejects(result, sdkErrorCodes.requestTimeout, delivery);
    assert.equal(transport.sent[0].options.signal.aborted, true);
    assert.equal(clock.timerCount, 0);
    await drain(clock);
  }
});

test("SE-04: remote error becomes a safe REMOTE_ERROR with delivered state", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  transport.sendImpl = (message) => {
    transport.accept({
      type: "response",
      requestId: message.requestId,
      ok: false,
      error: { code: "BUSINESS_RULE", message: "Denied", details: { retry: false } },
    });
    return Promise.resolve();
  };
  const session = new Session(transport, { clock });

  await assert.rejects(session.request("work", null), (error) => {
    assert.equal(error.code, sdkErrorCodes.remoteError);
    assert.equal(error.delivery, "delivered");
    assert.equal(error.remoteError.code, "BUSINESS_RULE");
    assert.deepEqual(error.remoteError.details, { retry: false });
    return true;
  });
  assert.equal(clock.timerCount, 0);
});

test("SE-05/06: Transport failures reject immediately with precise delivery", async () => {
  const cases = [
    [sdkErrorCodes.transportQueueFull, "not_sent"],
    [sdkErrorCodes.transportNotConnected, "not_sent"],
    [sdkErrorCodes.encodeError, "not_sent"],
    [sdkErrorCodes.deliveryUnconfirmed, "unknown"],
  ];

  for (const [code, delivery] of cases) {
    const clock = new FakeClock();
    const transport = new MemoryTransport();
    transport.sendImpl = () => Promise.reject(transportError(code, delivery));
    const session = new Session(transport, { clock, requestTimeoutMs: 100 });

    await assertSDKRejects(session.request("fail", null), code, delivery);
    assert.equal(clock.timerCount, 0);
  }
});

test("absolute deadline rejects a Response even when its timer callback is delayed", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const send = deferred();
  transport.sendImpl = () => send.promise;
  const session = new Session(transport, { clock, requestTimeoutMs: 10 });

  const result = session.request("slow", null);
  clock.setNow(10);
  respond(transport, 1, "too late");

  await assertSDKRejects(result, sdkErrorCodes.requestTimeout, "delivered");
  assert.equal(clock.timerCount, 0);
  send.reject(transportError(sdkErrorCodes.deliveryUnconfirmed, "unknown"));
  await drain(clock);
});

test("absolute deadline beats disconnect and every close path when the timer callback is delayed", async () => {
  const cases = [
    ["disconnect", (transport) => transport.disconnect()],
    ["explicit close", (_transport, session) => session.close()],
    ["localClosed", (transport) => transport.localClose()],
    ["peerClosed", (transport) => transport.peerClose()],
  ];

  for (const [name, terminate] of cases) {
    const clock = new FakeClock();
    const transport = new MemoryTransport();
    const send = deferred();
    transport.sendImpl = (_message, options) => {
      options.onDeliveryChange("delivered");
      return send.promise;
    };
    const session = new Session(transport, { clock, requestTimeoutMs: 10 });
    const result = session.request("slow", null);

    clock.setNow(10);
    await terminate(transport, session);
    await drain(clock);
    await assertSDKRejects(
      result,
      sdkErrorCodes.requestTimeout,
      "delivered",
    );
    assert.equal(clock.timerCount, 0, `${name} must clear the delayed timer`);

    send.reject(transportError(sdkErrorCodes.transportDisconnected, "unknown"));
    await drain(clock);
  }
});

test("disconnect and Transport close observed before deadline beat a delayed timer callback", async () => {
  const cases = [
    [
      "disconnect",
      (transport) => transport.disconnect(),
      sdkErrorCodes.transportDisconnected,
    ],
    ["localClosed", (transport) => transport.localClose(), sdkErrorCodes.sessionClosed],
    ["peerClosed", (transport) => transport.peerClose(), sdkErrorCodes.sessionClosed],
  ];

  for (const [name, terminate, expectedCode] of cases) {
    const clock = new FakeClock();
    const transport = new MemoryTransport();
    const session = new Session(transport, { clock, requestTimeoutMs: 10 });
    const result = session.request("slow", null);

    terminate(transport);
    clock.setNow(10);
    clock.runDueTimers();
    await drain(clock);

    await assertSDKRejects(result, expectedCode, "delivered");
    assert.equal(clock.timerCount, 0, `${name} must settle exactly once`);
  }
});

test("race: Response before ACK wins and a later send rejection is ignored", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const send = deferred();
  transport.sendImpl = () => send.promise;
  const session = new Session(transport, { clock });

  const result = session.request("race", null);
  respond(transport, 1, "winner");
  assert.equal(await result, "winner");

  send.reject(transportError(sdkErrorCodes.deliveryUnconfirmed, "unknown"));
  await drain(clock);
  assert.equal(clock.timerCount, 0);
});

test("race: Transport failure wins and a late Response is silently ignored", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const send = deferred();
  transport.sendImpl = () => send.promise;
  const session = new Session(transport, { clock });

  const result = session.request("race", null);
  send.reject(transportError(sdkErrorCodes.deliveryUnconfirmed, "unknown"));
  await assertSDKRejects(result, sdkErrorCodes.deliveryUnconfirmed, "unknown");
  assert.doesNotThrow(() => respond(transport, 1, "late"));
  assert.equal(clock.timerCount, 0);
});

test("race: Response and disconnect obey the first valid terminal event", async () => {
  {
    const clock = new FakeClock();
    const transport = new MemoryTransport();
    const session = new Session(transport, { clock });
    const result = session.request("race", null);

    respond(transport, 1, "response first");
    transport.disconnect();
    await drain(clock);
    assert.equal(await result, "response first");
  }

  {
    const clock = new FakeClock();
    const transport = new MemoryTransport();
    const session = new Session(transport, { clock });
    const result = session.request("race", null);

    transport.disconnect();
    await drain(clock);
    respond(transport, 1, "response late");
    await assertSDKRejects(
      result,
      sdkErrorCodes.transportDisconnected,
      "delivered",
    );
  }
});

test("race: Response and explicit close obey the first valid terminal event", async () => {
  {
    const clock = new FakeClock();
    const transport = new MemoryTransport();
    const session = new Session(transport, { clock });
    const result = session.request("race", null);

    respond(transport, 1, "response first");
    await session.close();
    assert.equal(await result, "response first");
  }

  {
    const clock = new FakeClock();
    const transport = new MemoryTransport();
    const session = new Session(transport, { clock });
    const result = session.request("race", null);

    await session.close();
    respond(transport, 1, "response late");
    await assertSDKRejects(result, sdkErrorCodes.sessionClosed, "delivered");
  }
});

test("a request started after disconnected() is not captured by the old disconnect sweep", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const firstSend = deferred();
  let call = 0;
  transport.sendImpl = () => {
    call += 1;
    return call === 1
      ? firstSend.promise
      : Promise.reject(
        transportError(sdkErrorCodes.transportNotConnected, "not_sent"),
      );
  };
  const session = new Session(transport, { clock });

  const before = session.request("before", null);
  transport.disconnect();
  const after = session.request("after", null);
  await drain(clock);

  await assertSDKRejects(
    before,
    sdkErrorCodes.transportDisconnected,
    "not_sent",
  );
  await assertSDKRejects(
    after,
    sdkErrorCodes.transportNotConnected,
    "not_sent",
  );
  firstSend.reject(transportError(sdkErrorCodes.transportDisconnected, "not_sent"));
  await drain(clock);
});

test("disconnect remains the first terminal event when close follows in the same stack", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const session = new Session(transport, { clock });
  const pending = session.request("outbound", null);

  transport.disconnect();
  await session.close();
  await assertSDKRejects(
    pending,
    sdkErrorCodes.transportDisconnected,
    "delivered",
  );
  await drain(clock);
  assert.equal(clock.timerCount, 0);
});

test("disconnect snapshot wins when send rejects after a Transport terminal close", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const send = deferred();
  transport.sendImpl = (_message, options) => {
    options.onDeliveryChange("unknown");
    return send.promise;
  };
  const session = new Session(transport, { clock });
  const pending = session.request("outbound", null);

  transport.disconnect();
  transport.peerClose();
  send.reject(
    transportError(sdkErrorCodes.transportDisconnected, "delivered"),
  );
  await drain(clock);

  await assertSDKRejects(
    pending,
    sdkErrorCodes.transportDisconnected,
    "unknown",
  );
  assert.equal(clock.timerCount, 0);
});

test("SE-10/11: disconnect rejects Pending but preserves handlers and requestId", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const session = new Session(transport, { clock });
  session.registerHandler("peer", (_payload, context) => context.requestId);

  const beforeDisconnect = session.request("outbound", null);
  transport.disconnect();
  await drain(clock);
  await assertSDKRejects(
    beforeDisconnect,
    sdkErrorCodes.transportDisconnected,
    "delivered",
  );

  transport.accept({ type: "request", requestId: 44, method: "peer", payload: null });
  await drain(clock);
  const peerResponse = transport.sent.find(
    ({ message }) => message.type === "response" && message.requestId === 44,
  );
  assert.equal(peerResponse.message.data, 44);

  transport.sendImpl = (message) => {
    if (message.type === "request") {
      respond(transport, message.requestId, "after reconnect");
    }
    return Promise.resolve();
  };
  assert.equal(await session.request("outbound", null), "after reconnect");
  const localRequests = transport.sent.filter(({ message }) => message.type === "request");
  assert.deepEqual(localRequests.map(({ message }) => message.requestId), [1, 2]);
});

test("SE-13: handlers execute concurrently and responses may be out of order", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const session = new Session(transport, { clock });
  const handlers = new Map();
  session.registerHandler("defer", (_payload, context) => {
    const operation = deferred();
    handlers.set(context.requestId, operation);
    return operation.promise;
  });

  transport.accept({ type: "request", requestId: 1, method: "defer", payload: null });
  transport.accept({ type: "request", requestId: 2, method: "defer", payload: null });
  await drain(clock);
  assert.equal(handlers.size, 2);

  handlers.get(2).resolve("second");
  await drain(clock);
  handlers.get(1).resolve("first");
  await drain(clock);

  assert.deepEqual(
    transport.sent.map(({ message }) => [message.requestId, message.data]),
    [[2, "second"], [1, "first"]],
  );
});

test("SE-14/15: replacement tokens keep stale unregister from removing the new handler", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const session = new Session(transport, { clock });
  const unregisterOld = session.registerHandler("method", () => "old");
  const unregisterNew = session.registerHandler("method", () => "new");

  unregisterOld();
  transport.accept({ type: "request", requestId: 1, method: "method", payload: null });
  await drain(clock);
  assert.equal(transport.sent[0].message.data, "new");

  unregisterNew();
  transport.accept({ type: "request", requestId: 2, method: "method", payload: null });
  await drain(clock);
  assert.equal(transport.sent.length, 1);
});

test("SE-16/17/18: malformed, unknown, late and duplicate messages are silent", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const session = new Session(transport, { clock });

  for (const message of [
    null,
    {},
    { type: "other" },
    { type: "response", requestId: 999, ok: true, data: null },
    { type: "request", requestId: 1, method: "missing", payload: null },
  ]) {
    assert.doesNotThrow(() => transport.accept(message));
  }
  assert.equal(transport.sent.length, 0);

  session.registerHandler("known", () => "alive");
  transport.accept({ type: "request", requestId: 2, method: "known", payload: null });
  await drain(clock);
  assert.equal(transport.sent[0].message.data, "alive");
});

test("SE-19/20/21: handler outcomes produce safe and serializable responses", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const session = new Session(transport, { clock });
  const cyclic = {};
  cyclic.self = cyclic;

  session.registerHandler("throw", () => {
    throw new Error("secret implementation detail");
  });
  session.registerHandler("undefined", () => undefined);
  session.registerHandler("bigint", () => 1n);
  session.registerHandler("cyclic", () => cyclic);

  for (const [requestId, method] of [
    [1, "throw"],
    [2, "undefined"],
    [3, "bigint"],
    [4, "cyclic"],
  ]) {
    transport.accept({ type: "request", requestId, method, payload: null });
  }
  await drain(clock);

  const byId = new Map(transport.sent.map(({ message }) => [message.requestId, message]));
  assert.deepEqual(byId.get(1), {
    type: "response",
    requestId: 1,
    ok: false,
    error: { code: "HANDLER_ERROR", message: "Remote handler failed." },
  });
  assert.deepEqual(byId.get(2), {
    type: "response",
    requestId: 2,
    ok: true,
    data: null,
  });
  for (const requestId of [3, 4]) {
    assert.equal(byId.get(requestId).ok, false);
    assert.equal(byId.get(requestId).error.code, "RESPONSE_NOT_SERIALIZABLE");
    assert.doesNotMatch(byId.get(requestId).error.message, /secret/i);
  }
});

test("SE-22/23: a failed error Response is diagnosed once and never recurses", async () => {
  const clock = new FakeClock();
  const diagnostics = [];
  const transport = new MemoryTransport();
  transport.sendImpl = () =>
    Promise.reject(
      transportError(sdkErrorCodes.transportQueueFull, "not_sent"),
    );
  const session = new Session(transport, {
    clock,
    onDiagnostic: (message, cause) => diagnostics.push({ message, cause }),
  });
  session.registerHandler("throw", () => {
    throw new Error("boom");
  });

  transport.accept({ type: "request", requestId: 1, method: "throw", payload: null });
  await drain(clock);
  assert.equal(transport.sent.length, 1);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /failed to send/i);
});

test("trace error formatting does not inspect hostile Error properties", async () => {
  const clock = new FakeClock();
  const events = [];
  const transport = new MemoryTransport();
  const hostile = new Error("private transport detail");
  Object.defineProperty(hostile, "name", {
    configurable: true,
    get() {
      throw new Error("name getter must not run");
    },
  });
  transport.sendImpl = (message) => {
    if (message.type === "response") {
      return Promise.reject(hostile);
    }
    return Promise.resolve();
  };
  const session = new Session(transport, {
    clock,
    traceLevel: "summary",
    onTrace: (event) => events.push(event),
  });
  session.registerHandler("work", () => "done");

  transport.accept({ type: "request", requestId: 1, method: "work", payload: null });
  await drain(clock);
  await new Promise((resolve) => setImmediate(resolve));

  const failed = events.find((event) => event.event === "response.sendFailed");
  assert.ok(failed);
  assert.equal(failed.details.reason, "error");
  await session.close();
});

test("SE-26: a handler from an old peerEpoch finishes but cannot respond on reconnect", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const first = deferred();
  let calls = 0;
  const session = new Session(transport, { clock });
  session.registerHandler("work", () => {
    calls += 1;
    return calls === 1 ? first.promise : "new epoch";
  });

  transport.accept({ type: "request", requestId: 1, method: "work", payload: null });
  await drain(clock);
  transport.disconnect();
  first.resolve("old epoch");
  await drain(clock);
  assert.equal(transport.sent.length, 0);

  transport.accept({ type: "request", requestId: 2, method: "work", payload: null });
  await drain(clock);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].message.data, "new epoch");
});

test("SE-24/28/31: close aborts Pending, calls Transport.close in-stack, and is terminal", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const handler = deferred();
  const send = deferred();
  let signal;
  let closeObservedAbort = false;
  transport.sendImpl = (message, options) => {
    if (message.type === "request") {
      signal = options.signal;
      return send.promise;
    }
    return Promise.resolve();
  };
  transport.closeImpl = () => {
    closeObservedAbort = signal.aborted;
    return Promise.resolve();
  };
  const session = new Session(transport, { clock });
  session.registerHandler("work", () => handler.promise);
  transport.accept({ type: "request", requestId: 10, method: "work", payload: null });
  await drain(clock);

  const pending = session.request("outbound", null);
  const closing = session.close();
  assert.equal(transport.closeCalls, 1);
  assert.equal(closeObservedAbort, true);
  assert.equal(transport.receiver, undefined);
  await closing;
  await assertSDKRejects(pending, sdkErrorCodes.sessionClosed, "not_sent");
  await assertSDKRejects(
    session.request("after-close", null),
    sdkErrorCodes.sessionClosed,
    "not_sent",
  );
  assert.throws(
    () => session.registerHandler("after-close", () => null),
    (error) => error.code === sdkErrorCodes.sessionClosed,
  );

  handler.resolve("late");
  send.reject(new Error("aborted"));
  await drain(clock);
  assert.equal(transport.sent.length, 1);
  assert.equal(clock.timerCount, 0);
  await session.close();
  assert.equal(transport.closeCalls, 1);
});

for (const [kind, closeTransport] of [
  ["localClosed", (transport) => transport.localClose()],
  ["peerClosed", (transport) => transport.peerClose()],
]) {
  test(`SE-25/30: ${kind} permanently closes Session without recursive Transport.close`, async () => {
    const clock = new FakeClock();
    const transport = new MemoryTransport();
    const session = new Session(transport, { clock });
    session.registerHandler("removed", () => "should not run");
    const pending = session.request("pending", null);

    closeTransport(transport);
    await drain(clock);
    await assertSDKRejects(pending, sdkErrorCodes.sessionClosed, "delivered");
    assert.equal(transport.closeCalls, 0);
    assert.equal(transport.receiver, undefined);
    assert.equal(clock.timerCount, 0);

    await assertSDKRejects(
      session.request("after-close", null),
      sdkErrorCodes.sessionClosed,
      "not_sent",
    );
    transport.accept({ type: "request", requestId: 2, method: "removed", payload: null });
    await drain(clock);
    assert.equal(transport.sent.length, 1);
  });
}

test("two symmetric Sessions may independently originate requestId 1", async () => {
  const leftTransport = new MemoryTransport();
  const rightTransport = new MemoryTransport();
  const left = new Session(leftTransport);
  const right = new Session(rightTransport);
  leftTransport.sendImpl = (message) => {
    respond(leftTransport, message.requestId, "left");
    return Promise.resolve();
  };
  rightTransport.sendImpl = (message) => {
    respond(rightTransport, message.requestId, "right");
    return Promise.resolve();
  };

  assert.deepEqual(await Promise.all([
    left.request("call", null),
    right.request("call", null),
  ]), ["left", "right"]);
  assert.equal(leftTransport.sent[0].message.requestId, 1);
  assert.equal(rightTransport.sent[0].message.requestId, 1);
});

test("notify is a native one-way message and never emits a Response", async () => {
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  const session = new Session(transport, { clock });
  const received = [];
  session.registerNotificationHandler("status", async (payload, context) => {
    received.push({ payload, context });
  });

  await session.notify("outbound", { stage: "queued" });
  assert.deepEqual(transport.sent[0].message, {
    type: "notify",
    method: "outbound",
    payload: { stage: "queued" },
  });

  transport.accept({
    type: "notify",
    method: "status",
    payload: { stage: "done" },
  });
  await drain(clock);
  assert.deepEqual(received, [{
    payload: { stage: "done" },
    context: { method: "status" },
  }]);
  assert.equal(transport.sent.length, 1);
});
