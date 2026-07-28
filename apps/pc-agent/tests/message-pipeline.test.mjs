import assert from "node:assert/strict";
import test from "node:test";
import { createInputService } from "../dist/input/input-service.js";
import {
  InputQueue,
  InputQueueFullError,
} from "../dist/input/input-queue.js";
import { MessageStore } from "../dist/messages/message-store.js";

test("MessageStore keeps 100 immutable records and publishes updates and clear", () => {
  const store = new MessageStore(100);
  const events = [];
  const unsubscribe = store.subscribe((event) => events.push(event));
  const first = store.create("websocket", "first");
  for (let index = 0; index < 100; index += 1) {
    store.create("hid", `hid-${index}`);
  }

  assert.equal(store.snapshot().length, 100);
  assert.equal(store.snapshot()[0].text, "hid-0");
  assert.equal(store.update(first.id, { status: "succeeded" }), undefined);

  const latest = store.snapshot().at(-1);
  store.update(latest.id, { status: "failed", error: "paste failed" });
  assert.deepEqual(store.snapshot().at(-1), {
    ...latest,
    status: "failed",
    error: "paste failed",
  });

  store.clear();
  assert.deepEqual(store.snapshot(), []);
  assert.equal(events.at(-1).type, "cleared");
  unsubscribe();
  store.create("websocket", "not observed");
  assert.equal(events.at(-1).type, "cleared");
});

test("WebSocket and HID inputs share one serial queue and expose lifecycle states", async () => {
  const store = new MessageStore();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const processed = [];
  const statuses = [];
  store.subscribe((event) => {
    if (event.type === "message") {
      statuses.push([event.message.text, event.message.status]);
    }
  });
  const queue = new InputQueue(store, async (text) => {
    processed.push(text);
    if (text === "from-ws") {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
  });
  const acceptText = createInputService(store, queue);

  const ws = acceptText("websocket", "from-ws");
  await firstStarted.promise;
  const hid = acceptText("hid", "from-hid");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processed, ["from-ws"]);

  releaseFirst.resolve();
  await Promise.all([ws, hid]);
  assert.deepEqual(processed, ["from-ws", "from-hid"]);
  assert.deepEqual(
    store.snapshot().map(({ source, status }) => [source, status]),
    [["websocket", "succeeded"], ["hid", "succeeded"]],
  );
  assert.ok(statuses.some(([text, status]) =>
    text === "from-hid" && status === "queued"
  ));
  assert.ok(statuses.some(([text, status]) =>
    text === "from-hid" && status === "processing"
  ));
});

test("queue overflow and processor errors mark their messages failed", async () => {
  const store = new MessageStore();
  const activeStarted = deferred();
  const releaseActive = deferred();
  const queue = new InputQueue(store, async (text) => {
    if (text === "active") {
      activeStarted.resolve();
      await releaseActive.promise;
    }
    if (text === "processor-error") throw new Error("paste failed");
  }, 1);
  const acceptText = createInputService(store, queue);

  const active = acceptText("websocket", "active");
  await activeStarted.promise;
  const waiting = acceptText("hid", "waiting");
  await assert.rejects(
    acceptText("websocket", "overflow"),
    InputQueueFullError,
  );
  assert.equal(store.snapshot().at(-1).status, "failed");

  releaseActive.resolve();
  await Promise.all([active, waiting]);
  await assert.rejects(
    acceptText("hid", "processor-error"),
    /paste failed/,
  );
  assert.deepEqual(store.snapshot().at(-1), {
    ...store.snapshot().at(-1),
    status: "failed",
    error: "paste failed",
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
