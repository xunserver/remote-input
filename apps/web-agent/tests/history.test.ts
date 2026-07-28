import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebHidHistoryMessage,
  loadWebHidHistory,
  maxWebHidHistoryItems,
  saveWebHidHistory,
  webHidHistoryStorageKey,
} from "../src/history.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("WebHID history round-trips individual messages with timestamps", () => {
  const storage = new MemoryStorage();
  const message = createWebHidHistoryMessage(
    "第一条\n保留换行",
    new Date("2026-07-28T15:30:00.000Z"),
    "message-1",
  );

  assert.equal(saveWebHidHistory([message], storage), true);
  assert.deepEqual(loadWebHidHistory(storage), [message]);
});

test("WebHID history ignores corrupt entries and keeps the newest 100", () => {
  const storage = new MemoryStorage();
  const messages = Array.from(
    { length: maxWebHidHistoryItems + 2 },
    (_, index) => ({
      id: `message-${index}`,
      receivedAt: new Date(1_700_000_000_000 + index).toISOString(),
      text: `内容 ${index}`,
    }),
  );
  storage.setItem(
    webHidHistoryStorageKey,
    JSON.stringify([{ id: "", receivedAt: "invalid", text: 1 }, ...messages]),
  );

  const loaded = loadWebHidHistory(storage);
  assert.equal(loaded.length, maxWebHidHistoryItems);
  assert.equal(loaded[0]?.id, "message-2");
  assert.equal(loaded.at(-1)?.id, `message-${maxWebHidHistoryItems + 1}`);
});

test("WebHID history tolerates unavailable storage", () => {
  const brokenStorage = {
    getItem() {
      throw new Error("unavailable");
    },
    setItem() {
      throw new Error("unavailable");
    },
  };

  assert.deepEqual(loadWebHidHistory(brokenStorage), []);
  assert.equal(saveWebHidHistory([], brokenStorage), false);
});
