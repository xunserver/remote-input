import assert from "node:assert/strict";
import test from "node:test";
import {
  createClipboardInputProcessor,
} from "../dist/clipboard.js";

test("copy-only control skips paste and can restore the original clipboard", async () => {
  let clipboard = "original";
  let pasteCount = 0;
  const writes = [];
  const stages = [];
  const processor = createClipboardInputProcessor(
    {
      read: async () => clipboard,
      write: async (text) => {
        clipboard = text;
        writes.push(text);
      },
    },
    async () => {
      pasteCount += 1;
    },
    async () => {},
  );

  await processor(
    {
      text: "remote",
      control: { paste: false, restoreClipboard: true },
    },
    (stage) => stages.push(stage),
  );

  assert.equal(pasteCount, 0);
  assert.equal(clipboard, "original");
  assert.deepEqual(writes, ["remote", "original"]);
  assert.deepEqual(stages, ["copied", "clipboard_restored"]);
});

test("paste control keeps remote text when restore is disabled", async () => {
  let clipboard = "original";
  const pasted = [];
  const processor = createClipboardInputProcessor(
    {
      read: async () => clipboard,
      write: async (text) => {
        clipboard = text;
      },
    },
    async () => pasted.push(clipboard),
  );

  await processor(
    {
      text: "remote",
      control: { paste: true, restoreClipboard: false },
    },
    () => {},
  );

  assert.deepEqual(pasted, ["remote"]);
  assert.equal(clipboard, "remote");
});
