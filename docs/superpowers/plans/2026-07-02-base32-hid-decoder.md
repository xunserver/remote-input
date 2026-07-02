# Base32 HID Decoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace firmware `Alt` + Unicode HID typing with RIB32 ASCII frame typing and add a standalone target-side web decoder that reconstructs copyable UTF-8 text.

**Architecture:** Keep the existing SDK-to-ESP32 BLE/WebSocket binary protocol unchanged. Add a tested TypeScript RIB32 parser/aggregator for `sdk/decode.html`, and add a firmware-side RIB32 encoder used by the USB HID writer. The firmware only types ASCII frame lines; the target browser page owns Base32 decoding, chunk validation, task grouping, and final UTF-8 display.

**Tech Stack:** ESP-IDF C firmware, TinyUSB HID keyboard reports, TypeScript ES modules, Vite, Node `assert` tests.

## Global Constraints

- Existing BLE/WebSocket binary protocol remains version `2`.
- RIB32 USB HID output text format is version `1`.
- RIB32 Base32 uses RFC 4648 alphabet `A-Z2-7` with no `=` padding.
- RIB32 payload chunk size is `32` raw UTF-8 bytes.
- CRC fields are standard CRC32 values rendered as eight uppercase hexadecimal characters.
- Do not run `idf.py flash`, `idf.py monitor`, or commands containing `flash`/`monitor`.
- Use `npm --prefix sdk run test:sdk` for SDK verification.
- Use `eim run "idf.py -C firmware -B firmware/build build"` for firmware verification.

---

## File Structure

- Create `sdk/src/base32Frame.ts`: RIB32 Base32, CRC32, line formatting, line parsing, task aggregation, final UTF-8 decoding.
- Create `sdk/tests/base32-frame.test.js`: Node tests for the RIB32 module by importing TypeScript through `tsx`.
- Modify `sdk/package.json`: add `tsx` dev dependency and include the new test in `test:sdk`.
- Create `sdk/decode.html`: target-side decoder page.
- Modify `sdk/styles.css`: styles for the decoder page while preserving the existing demo page.
- Modify `sdk/tests/sdk-protocol.test.js`: assert demo copy no longer mentions EnableHexNumpad and assert `decode.html` exists with module imports.
- Create `firmware/components/remote_input_device/include/remote_input_rib32.h`: firmware RIB32 formatting interface.
- Create `firmware/components/remote_input_device/remote_input_rib32.c`: firmware Base32/CRC32/frame writer.
- Modify `firmware/components/remote_input_device/CMakeLists.txt`: compile `remote_input_rib32.c`.
- Modify `firmware/components/remote_input_device/remote_input_hid.c`: remove Alt+Unicode path and type RIB32 ASCII lines.
- Modify `firmware/components/remote_input_device/include/remote_input_hid.h`: remove exported codepoint typing declaration.
- Modify `docs/remote-input-protocol.md`: document RIB32 output format and new target workflow.

---

### Task 1: SDK RIB32 Core

**Files:**
- Create: `sdk/src/base32Frame.ts`
- Create: `sdk/tests/base32-frame.test.js`
- Modify: `sdk/package.json`
- Modify: `sdk/src/index.ts`

**Interfaces:**
- Produces:
  - `RIB32_VERSION: 1`
  - `RIB32_CHUNK_BYTES: 32`
  - `base32Encode(bytes: Uint8Array): string`
  - `base32Decode(text: string): Uint8Array`
  - `crc32(bytes: Uint8Array): number`
  - `formatRib32Frames(taskId: number, bytes: Uint8Array): string[]`
  - `createRib32DecoderState(): Rib32DecoderState`
  - `ingestRib32Text(state: Rib32DecoderState, text: string): Rib32DecoderState`
  - `getRib32Tasks(state: Rib32DecoderState): Rib32TaskView[]`
- Consumes: no earlier task output.

- [ ] **Step 1: Add the test runner dependency and script**

In `sdk/package.json`, set `test:sdk` to run both existing and new tests, and add `tsx`:

```json
{
  "name": "remote-input",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build:sdk": "vite build",
    "test:sdk": "npm run build:sdk && node tests/sdk-protocol.test.js && npx tsx tests/base32-frame.test.js"
  },
  "devDependencies": {
    "@types/node": "^26.0.1",
    "tslib": "^2.8.1",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vite": "^7.2.7"
  }
}
```

- [ ] **Step 2: Write failing SDK RIB32 tests**

Create `sdk/tests/base32-frame.test.js`:

```js
const assert = require("node:assert/strict");

const {
  RIB32_CHUNK_BYTES,
  base32Decode,
  base32Encode,
  crc32,
  createRib32DecoderState,
  formatRib32Frames,
  getRib32Tasks,
  ingestRib32Text,
} = require("../src/base32Frame.ts");

const encoder = new TextEncoder();

function decodeTask(lines) {
  const state = createRib32DecoderState();
  ingestRib32Text(state, `${lines.join("\n")}\n`);
  return getRib32Tasks(state)[0];
}

{
  const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 250, 255]);
  const encoded = base32Encode(bytes);
  assert.equal(encoded, "AAAQEAYEAUC7V7Y");
  assert.deepEqual(Array.from(base32Decode(encoded)), Array.from(bytes));
  assert.deepEqual(Array.from(base32Decode(encoded.toLowerCase())), Array.from(bytes));
}

{
  assert.equal(crc32(encoder.encode("123456789")).toString(16).toUpperCase(), "CBF43926");
}

{
  const text = "中文 English 😀\n第二行";
  const lines = formatRib32Frames(7, encoder.encode(text));
  assert.match(lines[0], /^<RIB32:1:7:0:\d+:[0-9A-F]{8}:[A-Z2-7]+>$/);
  assert.match(lines.at(-1), /^<\/RIB32:1:7:[0-9A-F]{8}>$/);
  const task = decodeTask(lines);
  assert.equal(task.taskId, 7);
  assert.equal(task.status, "complete");
  assert.equal(task.decodedText, text);
  assert.deepEqual(task.errors, []);
}

{
  const lines = formatRib32Frames(8, new Uint8Array());
  assert.equal(lines.length, 2);
  const task = decodeTask(lines);
  assert.equal(task.status, "complete");
  assert.equal(task.decodedText, "");
}

{
  const bytes = new Uint8Array(RIB32_CHUNK_BYTES * 2 + 1);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
  const lines = formatRib32Frames(9, bytes);
  const state = createRib32DecoderState();
  ingestRib32Text(state, `${lines[1]}\n${lines[0]}\n${lines[2]}\n${lines[3]}\n`);
  const task = getRib32Tasks(state)[0];
  assert.equal(task.status, "complete");
  assert.deepEqual(Array.from(task.decodedBytes), Array.from(bytes));
}

{
  const lines = formatRib32Frames(10, encoder.encode("一二三四五六七八九十"));
  const damaged = [...lines];
  damaged[0] = damaged[0].replace(/[A-Z2-7](?=>)/, "A");
  const task = decodeTask(damaged);
  assert.equal(task.status, "error");
  assert.match(task.errors.join("\n"), /chunk 0/i);
  assert.equal(task.decodedText, undefined);
}

{
  const lines = formatRib32Frames(11, encoder.encode("missing chunk ".repeat(8)));
  const task = decodeTask([lines[0], lines.at(-1)]);
  assert.equal(task.status, "error");
  assert.match(task.errors.join("\n"), /missing chunk 1/i);
}

{
  const valid = formatRib32Frames(12, encoder.encode("duplicate chunk ".repeat(4)));
  const state = createRib32DecoderState();
  ingestRib32Text(state, `${valid[0].replace(/:0:/, ":0:").replace(/[A-Z2-7](?=>)/, "A")}\n`);
  ingestRib32Text(state, `${valid.join("\n")}\n`);
  const task = getRib32Tasks(state)[0];
  assert.equal(task.status, "complete");
}

{
  const a = formatRib32Frames(13, encoder.encode("A".repeat(40)));
  const b = formatRib32Frames(13, encoder.encode("B".repeat(40)));
  const task = decodeTask([a[0], b[0], a.at(-1)]);
  assert.equal(task.status, "error");
  assert.match(task.errors.join("\n"), /conflict/i);
}

{
  const lines = formatRib32Frames(14, encoder.encode("bad end crc"));
  lines[lines.length - 1] = lines[lines.length - 1].replace(/[0-9A-F]{8}/, "00000000");
  const task = decodeTask(lines);
  assert.equal(task.status, "error");
  assert.match(task.errors.join("\n"), /message crc/i);
}

{
  const linesA = formatRib32Frames(15, encoder.encode("第一段"));
  const linesB = formatRib32Frames(16, encoder.encode("第二段"));
  const state = createRib32DecoderState();
  ingestRib32Text(state, `${linesA.join("\n")}\n${linesB.join("\n")}\n`);
  const tasks = getRib32Tasks(state);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].decodedText, "第一段");
  assert.equal(tasks[1].decodedText, "第二段");
}
```

- [ ] **Step 3: Run the new test to verify it fails**

Run:

```bash
npm --prefix sdk install
npm --prefix sdk run test:sdk
```

Expected: FAIL because `sdk/src/base32Frame.ts` does not exist.

- [ ] **Step 4: Implement `sdk/src/base32Frame.ts`**

Create `sdk/src/base32Frame.ts` with these exported names and behavior:

```ts
export const RIB32_VERSION = 1;
export const RIB32_CHUNK_BYTES = 32;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CHUNK_RE = /^<RIB32:1:(\d+):(\d+):(\d+):([0-9A-Fa-f]{8}):([A-Za-z2-7]*)>$/;
const END_RE = /^<\/RIB32:1:(\d+):([0-9A-Fa-f]{8})>$/;

export type Rib32TaskStatus = "receiving" | "complete" | "error";

type StoredChunk = {
  index: number;
  total: number;
  bytes?: Uint8Array;
  crc?: number;
  errors: string[];
  conflict: boolean;
};

type Rib32TaskState = {
  taskId: number;
  order: number;
  chunkTotal?: number;
  messageCrc?: number;
  chunks: Map<number, StoredChunk>;
  lineErrors: string[];
};

export type Rib32DecoderState = {
  nextOrder: number;
  scannedLineCount: number;
  buffer: string;
  tasks: Map<number, Rib32TaskState>;
};

export type Rib32TaskView = {
  taskId: number;
  status: Rib32TaskStatus;
  chunkTotal?: number;
  receivedValidChunks: number;
  errors: string[];
  decodedBytes?: Uint8Array;
  decodedText?: string;
};

export function base32Encode(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "").toUpperCase();
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const value = BASE32_ALPHABET.indexOf(ch);
    if (value < 0) {
      throw new Error(`Invalid Base32 character: ${ch}`);
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits > 0 && ((buffer << (8 - bits)) & 0xff) !== 0) {
    throw new Error("Invalid Base32 trailing bits");
  }
  return new Uint8Array(out);
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function formatRib32Frames(taskId: number, bytes: Uint8Array): string[] {
  if (!Number.isInteger(taskId) || taskId < 1 || taskId > 65535) {
    throw new Error("taskId must be an integer from 1 to 65535");
  }
  const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / RIB32_CHUNK_BYTES));
  const lines: string[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = bytes.slice(index * RIB32_CHUNK_BYTES, (index + 1) * RIB32_CHUNK_BYTES);
    lines.push(`<RIB32:${RIB32_VERSION}:${taskId}:${index}:${totalChunks}:${hex32(crc32(chunk))}:${base32Encode(chunk)}>`);
  }
  lines.push(`</RIB32:${RIB32_VERSION}:${taskId}:${hex32(crc32(bytes))}>`);
  return lines;
}

export function createRib32DecoderState(): Rib32DecoderState {
  return { nextOrder: 0, scannedLineCount: 0, buffer: "", tasks: new Map() };
}

function taskFor(state: Rib32DecoderState, taskId: number): Rib32TaskState {
  let task = state.tasks.get(taskId);
  if (!task) {
    task = { taskId, order: state.nextOrder, chunks: new Map(), lineErrors: [] };
    state.nextOrder += 1;
    state.tasks.set(taskId, task);
  }
  return task;
}

function parseHex(value: string): number {
  return Number.parseInt(value, 16) >>> 0;
}

function ingestLine(state: Rib32DecoderState, rawLine: string): void {
  const line = rawLine.trim();
  if (line.length === 0) return;

  const chunkMatch = CHUNK_RE.exec(line);
  if (chunkMatch) {
    const taskId = Number(chunkMatch[1]);
    const index = Number(chunkMatch[2]);
    const total = Number(chunkMatch[3]);
    const expectedCrc = parseHex(chunkMatch[4]);
    const payload = chunkMatch[5];
    const task = taskFor(state, taskId);
    task.chunkTotal = task.chunkTotal ?? total;
    if (task.chunkTotal !== total) task.lineErrors.push(`task ${taskId} chunk total changed`);

    let chunk: StoredChunk = task.chunks.get(index) ?? { index, total, errors: [], conflict: false };
    const errors: string[] = [];
    let bytes: Uint8Array | undefined;
    try {
      bytes = base32Decode(payload);
      if (crc32(bytes) !== expectedCrc) errors.push(`chunk ${index} crc mismatch`);
    } catch (error) {
      errors.push(`chunk ${index} ${(error as Error).message}`);
    }

    if (bytes && errors.length === 0) {
      if (!chunk.bytes || chunk.errors.length > 0) {
        chunk = { index, total, bytes, crc: expectedCrc, errors: [], conflict: false };
      } else if (chunk.crc !== expectedCrc || !equalBytes(chunk.bytes, bytes)) {
        chunk.conflict = true;
        chunk.errors = [`chunk ${index} conflict`];
      }
    } else if (!chunk.bytes) {
      chunk = { index, total, errors, conflict: false };
    }
    task.chunks.set(index, chunk);
    return;
  }

  const endMatch = END_RE.exec(line);
  if (endMatch) {
    const taskId = Number(endMatch[1]);
    const task = taskFor(state, taskId);
    task.messageCrc = parseHex(endMatch[2]);
    return;
  }

  state.lineErrors = state.lineErrors ?? [];
  const synthetic = taskFor(state, 0);
  synthetic.lineErrors.push(`unrecognized line ${state.scannedLineCount + 1}`);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function ingestRib32Text(state: Rib32DecoderState, text: string): Rib32DecoderState {
  state.buffer += text;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? "";
  for (const line of lines) {
    ingestLine(state, line);
    state.scannedLineCount += 1;
  }
  return state;
}

export function getRib32Tasks(state: Rib32DecoderState): Rib32TaskView[] {
  return Array.from(state.tasks.values())
    .filter((task) => task.taskId !== 0)
    .sort((a, b) => a.order - b.order)
    .map(viewTask);
}

function viewTask(task: Rib32TaskState): Rib32TaskView {
  const errors = [...task.lineErrors];
  const total = task.chunkTotal;
  const validChunks: Uint8Array[] = [];
  if (total !== undefined) {
    for (let index = 0; index < total; index += 1) {
      const chunk = task.chunks.get(index);
      if (!chunk) {
        errors.push(`missing chunk ${index}`);
      } else if (chunk.errors.length > 0 || chunk.conflict) {
        errors.push(...chunk.errors);
      } else if (chunk.bytes) {
        validChunks[index] = chunk.bytes;
      }
    }
  }
  if (task.messageCrc === undefined) {
    return { taskId: task.taskId, status: errors.length ? "error" : "receiving", chunkTotal: total, receivedValidChunks: validChunks.filter(Boolean).length, errors };
  }
  if (total === undefined) errors.push("missing chunk total");
  if (errors.length > 0 || total === undefined) {
    return { taskId: task.taskId, status: "error", chunkTotal: total, receivedValidChunks: validChunks.filter(Boolean).length, errors };
  }
  const decodedBytes = joinChunks(validChunks);
  if (crc32(decodedBytes) !== task.messageCrc) {
    return { taskId: task.taskId, status: "error", chunkTotal: total, receivedValidChunks: validChunks.length, errors: ["message crc mismatch"] };
  }
  try {
    const decodedText = new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes);
    return { taskId: task.taskId, status: "complete", chunkTotal: total, receivedValidChunks: validChunks.length, errors: [], decodedBytes, decodedText };
  } catch {
    return { taskId: task.taskId, status: "error", chunkTotal: total, receivedValidChunks: validChunks.length, errors: ["invalid utf-8"] };
  }
}
```

- [ ] **Step 5: Export internals for tests and optional consumers**

In `sdk/src/index.ts`, import and expose RIB32 internals:

```ts
import {
  RIB32_CHUNK_BYTES,
  RIB32_VERSION,
  base32Decode,
  base32Encode,
  crc32,
  createRib32DecoderState,
  formatRib32Frames,
  getRib32Tasks,
  ingestRib32Text,
} from "./base32Frame";
```

Add these names to `_internals`:

```ts
  RIB32_VERSION,
  RIB32_CHUNK_BYTES,
  base32Encode,
  base32Decode,
  crc32,
  formatRib32Frames,
  createRib32DecoderState,
  ingestRib32Text,
  getRib32Tasks,
```

- [ ] **Step 6: Run SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sdk/package.json sdk/package-lock.json sdk/src/base32Frame.ts sdk/src/index.ts sdk/tests/base32-frame.test.js
git commit -m "feat: add rib32 sdk decoder core"
```

---

### Task 2: Target Decoder Page

**Files:**
- Create: `sdk/decode.html`
- Modify: `sdk/styles.css`
- Modify: `sdk/index.html`
- Modify: `sdk/tests/sdk-protocol.test.js`

**Interfaces:**
- Consumes from Task 1:
  - `createRib32DecoderState()`
  - `ingestRib32Text(state, text)`
  - `getRib32Tasks(state)`
- Produces:
  - A standalone browser page at `sdk/decode.html`.

- [ ] **Step 1: Add failing HTML assertions**

In `sdk/tests/sdk-protocol.test.js`, after the existing `demoHtml` assertions, add:

```js
assert.doesNotMatch(demoHtml, /EnableHexNumpad/);
assert.match(demoHtml, /decode\.html/);

const decodeHtml = fs.readFileSync("decode.html", "utf8");
assert.match(decodeHtml, /<title>Remote Input Decoder<\/title>/);
assert.match(decodeHtml, /import .*base32Frame.* from "\.\/src\/base32Frame\.ts"|from "\.\/src\/base32Frame\.ts"/);
assert.match(decodeHtml, /id="rib32Input"/);
assert.match(decodeHtml, /id="taskList"/);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: FAIL because `decode.html` does not exist and `index.html` still mentions EnableHexNumpad.

- [ ] **Step 3: Create `sdk/decode.html`**

Create `sdk/decode.html`:

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Remote Input Decoder</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="app app--decoder">
    <section class="panel decoder-panel">
      <header class="decoder-header">
        <h1>Remote Input Decoder</h1>
        <button id="clearButton" type="button">清空</button>
      </header>
      <p class="hint">把光标保持在输入框内，等待 ESP32-S3 输入 RIB32 文本帧。完整校验通过后再复制中文结果。</p>
      <textarea id="rib32Input" rows="10" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="<RIB32:1:...>"></textarea>
      <section id="taskList" class="task-list" aria-live="polite"></section>
    </section>
  </main>
  <script type="module">
    import { createRib32DecoderState, getRib32Tasks, ingestRib32Text } from "./src/base32Frame.ts";

    const input = document.querySelector("#rib32Input");
    const taskList = document.querySelector("#taskList");
    const clearButton = document.querySelector("#clearButton");
    let state = createRib32DecoderState();

    function render() {
      const tasks = getRib32Tasks(state);
      taskList.replaceChildren();
      if (tasks.length === 0) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "等待输入";
        taskList.append(empty);
        return;
      }
      for (const task of tasks) {
        const article = document.createElement("article");
        article.className = `task-card task-card--${task.status}`;

        const title = document.createElement("h2");
        title.textContent = `Task ${task.taskId} - ${task.status}`;
        article.append(title);

        const progress = document.createElement("p");
        progress.className = "hint";
        progress.textContent = `Chunks ${task.receivedValidChunks}/${task.chunkTotal ?? "?"}`;
        article.append(progress);

        if (task.errors.length > 0) {
          const errors = document.createElement("pre");
          errors.textContent = task.errors.join("\n");
          article.append(errors);
        }

        if (task.status === "complete" && task.decodedText !== undefined) {
          const output = document.createElement("textarea");
          output.rows = 6;
          output.readOnly = true;
          output.value = task.decodedText;
          article.append(output);

          const copy = document.createElement("button");
          copy.type = "button";
          copy.textContent = "复制";
          copy.addEventListener("click", async () => {
            await navigator.clipboard.writeText(task.decodedText ?? "");
            copy.textContent = "已复制";
            setTimeout(() => { copy.textContent = "复制"; }, 1200);
          });
          article.append(copy);
        }

        taskList.append(article);
      }
    }

    input.addEventListener("input", () => {
      ingestRib32Text(state, input.value);
      input.value = state.buffer;
      render();
    });

    clearButton.addEventListener("click", () => {
      state = createRib32DecoderState();
      input.value = "";
      render();
      input.focus();
    });

    render();
    input.focus();
  </script>
</body>
</html>
```

- [ ] **Step 4: Update demo copy in `sdk/index.html`**

Replace the existing hint paragraph:

```html
<p class="hint">目标 Windows 需要先启用 EnableHexNumpad，并把光标放到 Notepad 或标准文本框中。</p>
```

with:

```html
<p class="hint">目标设备打开 <a href="./decode.html" target="_blank" rel="noreferrer">decode.html</a>，并把光标放在 RIB32 输入框中。</p>
```

Also update the textarea placeholder to:

```html
<textarea id="textInput" rows="8" maxlength="131072" placeholder="输入要发送到目标设备的文本"></textarea>
```

- [ ] **Step 5: Add decoder styles**

Append to `sdk/styles.css`:

```css
a {
  color: #1d4ed8;
}

.app--decoder {
  place-items: start center;
}

.decoder-panel {
  width: min(960px, 100%);
}

.decoder-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.decoder-header h1 {
  margin: 0;
}

.task-list {
  display: grid;
  gap: 12px;
}

.task-card {
  border: 1px solid #cbd2d9;
  border-radius: 6px;
  background: #ffffff;
  padding: 12px;
  display: grid;
  gap: 10px;
}

.task-card h2 {
  margin: 0;
  font-size: 16px;
}

.task-card--complete {
  border-color: #2f855a;
}

.task-card--error {
  border-color: #c2410c;
}
```

- [ ] **Step 6: Run SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sdk/decode.html sdk/index.html sdk/styles.css sdk/tests/sdk-protocol.test.js
git commit -m "feat: add rib32 decoder page"
```

---

### Task 3: Firmware RIB32 Encoder

**Files:**
- Create: `firmware/components/remote_input_device/include/remote_input_rib32.h`
- Create: `firmware/components/remote_input_device/remote_input_rib32.c`
- Modify: `firmware/components/remote_input_device/CMakeLists.txt`

**Interfaces:**
- Consumes: raw validated UTF-8 bytes and task id from `remote_input_hid_write_text()`.
- Produces:
  - `REMOTE_INPUT_RIB32_CHUNK_BYTES`
  - `typedef esp_err_t (*remote_input_rib32_line_cb_t)(const char *line, void *ctx);`
  - `esp_err_t remote_input_rib32_emit(uint16_t task_id, const uint8_t *bytes, size_t len, remote_input_rib32_line_cb_t cb, void *ctx);`

- [ ] **Step 1: Create the public header**

Create `firmware/components/remote_input_device/include/remote_input_rib32.h`:

```c
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define REMOTE_INPUT_RIB32_VERSION 1
#define REMOTE_INPUT_RIB32_CHUNK_BYTES 32

typedef esp_err_t (*remote_input_rib32_line_cb_t)(const char *line, void *ctx);

esp_err_t remote_input_rib32_emit(uint16_t task_id,
                                  const uint8_t *bytes,
                                  size_t len,
                                  remote_input_rib32_line_cb_t cb,
                                  void *ctx);
```

- [ ] **Step 2: Implement CRC32 and Base32 helpers**

Create `firmware/components/remote_input_device/remote_input_rib32.c` with:

```c
#include "remote_input_rib32.h"

#include <stdio.h>
#include <string.h>

#define RIB32_MAX_BASE32_CHARS (((REMOTE_INPUT_RIB32_CHUNK_BYTES * 8) + 4) / 5)
#define RIB32_MAX_LINE_CHARS 128

static const char s_base32_alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

static uint32_t crc32_bytes(const uint8_t *bytes, size_t len)
{
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; ++i) {
        crc ^= bytes[i];
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1) ^ ((crc & 1u) ? 0xEDB88320u : 0u);
        }
    }
    return crc ^ 0xFFFFFFFFu;
}

static size_t base32_encode(const uint8_t *bytes, size_t len, char *out, size_t out_len)
{
    uint32_t buffer = 0;
    int bits = 0;
    size_t written = 0;

    for (size_t i = 0; i < len; ++i) {
        buffer = (buffer << 8) | bytes[i];
        bits += 8;
        while (bits >= 5) {
            if (written + 1 >= out_len) {
                return 0;
            }
            out[written++] = s_base32_alphabet[(buffer >> (bits - 5)) & 31u];
            bits -= 5;
        }
    }

    if (bits > 0) {
        if (written + 1 >= out_len) {
            return 0;
        }
        out[written++] = s_base32_alphabet[(buffer << (5 - bits)) & 31u];
    }
    out[written] = '\0';
    return written;
}
```

- [ ] **Step 3: Implement `remote_input_rib32_emit()`**

Append:

```c
esp_err_t remote_input_rib32_emit(uint16_t task_id,
                                  const uint8_t *bytes,
                                  size_t len,
                                  remote_input_rib32_line_cb_t cb,
                                  void *ctx)
{
    if ((bytes == NULL && len > 0) || cb == NULL || task_id == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    const size_t total_chunks = len == 0 ? 1 : (len + REMOTE_INPUT_RIB32_CHUNK_BYTES - 1) / REMOTE_INPUT_RIB32_CHUNK_BYTES;
    if (total_chunks > UINT16_MAX) {
        return ESP_ERR_INVALID_SIZE;
    }

    for (size_t index = 0; index < total_chunks; ++index) {
        const size_t offset = index * REMOTE_INPUT_RIB32_CHUNK_BYTES;
        const size_t remaining = len > offset ? len - offset : 0;
        const size_t chunk_len = remaining > REMOTE_INPUT_RIB32_CHUNK_BYTES ? REMOTE_INPUT_RIB32_CHUNK_BYTES : remaining;
        const uint8_t *chunk = chunk_len > 0 ? bytes + offset : NULL;
        char payload[RIB32_MAX_BASE32_CHARS + 1] = {0};
        char line[RIB32_MAX_LINE_CHARS] = {0};

        if (base32_encode(chunk, chunk_len, payload, sizeof(payload)) == 0 && chunk_len > 0) {
            return ESP_ERR_INVALID_SIZE;
        }

        int written = snprintf(line,
                               sizeof(line),
                               "<RIB32:%d:%u:%u:%u:%08lX:%s>",
                               REMOTE_INPUT_RIB32_VERSION,
                               (unsigned)task_id,
                               (unsigned)index,
                               (unsigned)total_chunks,
                               (unsigned long)crc32_bytes(chunk, chunk_len),
                               payload);
        if (written <= 0 || written >= (int)sizeof(line)) {
            return ESP_ERR_INVALID_SIZE;
        }

        esp_err_t err = cb(line, ctx);
        if (err != ESP_OK) {
            return err;
        }
    }

    char end_line[RIB32_MAX_LINE_CHARS] = {0};
    int written = snprintf(end_line,
                           sizeof(end_line),
                           "</RIB32:%d:%u:%08lX>",
                           REMOTE_INPUT_RIB32_VERSION,
                           (unsigned)task_id,
                           (unsigned long)crc32_bytes(bytes, len));
    if (written <= 0 || written >= (int)sizeof(end_line)) {
        return ESP_ERR_INVALID_SIZE;
    }

    return cb(end_line, ctx);
}
```

- [ ] **Step 4: Add the source to CMake**

In `firmware/components/remote_input_device/CMakeLists.txt`, add:

```cmake
        "remote_input_rib32.c"
```

inside the `SRCS` list next to `remote_input_hid.c`.

- [ ] **Step 5: Build firmware**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS or C compiler errors in the new RIB32 source that must be fixed before continuing.

- [ ] **Step 6: Commit**

```bash
git add firmware/components/remote_input_device/include/remote_input_rib32.h firmware/components/remote_input_device/remote_input_rib32.c firmware/components/remote_input_device/CMakeLists.txt
git commit -m "feat: add firmware rib32 encoder"
```

---

### Task 4: HID Writer RIB32 Output

**Files:**
- Modify: `firmware/components/remote_input_device/remote_input_hid.c`
- Modify: `firmware/components/remote_input_device/include/remote_input_hid.h`

**Interfaces:**
- Consumes from Task 3:
  - `remote_input_rib32_emit(task_id, bytes, len, cb, ctx)`
- Produces:
  - USB HID writer output is ASCII RIB32 lines followed by `Enter`.

- [ ] **Step 1: Remove the exported codepoint typing API**

In `firmware/components/remote_input_device/include/remote_input_hid.h`, remove this declaration:

```c
esp_err_t remote_input_hid_type_codepoint(uint32_t codepoint, uint16_t key_delay_ms);
```

- [ ] **Step 2: Update includes and context in `remote_input_hid.c`**

Replace:

```c
#include <stdio.h>
```

with no `stdio.h` include unless another function still needs it.

Add:

```c
#include "remote_input_rib32.h"
```

Replace `hid_write_context_t` with:

```c
typedef struct {
    remote_input_error_t error;
    uint16_t key_delay_ms;
} hid_write_context_t;
```

Keep this type because the line callback still needs error mapping.

- [ ] **Step 3: Replace Alt-specific helpers with ASCII key mapping**

Delete `hex_keycode()`, `send_alt_modified_key()`, `remote_input_hid_type_codepoint()`, and `type_codepoint_cb()`.

Add these helpers after `release_all_keys()`:

```c
typedef struct {
    uint8_t modifier;
    uint8_t keycode;
} ascii_key_t;

static bool ascii_key_for_char(char ch, ascii_key_t *out)
{
    if (out == NULL) {
        return false;
    }

    if (ch >= 'A' && ch <= 'Z') {
        out->modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
        out->keycode = HID_KEY_A + (uint8_t)(ch - 'A');
        return true;
    }
    if (ch >= 'a' && ch <= 'z') {
        out->modifier = 0;
        out->keycode = HID_KEY_A + (uint8_t)(ch - 'a');
        return true;
    }
    if (ch >= '1' && ch <= '9') {
        out->modifier = 0;
        out->keycode = HID_KEY_1 + (uint8_t)(ch - '1');
        return true;
    }
    if (ch == '0') {
        out->modifier = 0;
        out->keycode = HID_KEY_0;
        return true;
    }

    switch (ch) {
    case '<':
        out->modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
        out->keycode = HID_KEY_COMMA;
        return true;
    case '>':
        out->modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
        out->keycode = HID_KEY_PERIOD;
        return true;
    case '/':
        out->modifier = 0;
        out->keycode = HID_KEY_SLASH;
        return true;
    case ':':
        out->modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
        out->keycode = HID_KEY_SEMICOLON;
        return true;
    default:
        return false;
    }
}

static esp_err_t send_key(uint8_t modifier, uint8_t keycode, uint16_t key_delay_ms)
{
    const uint8_t keys[6] = {keycode, 0, 0, 0, 0, 0};
    const uint8_t no_keys[6] = {0};

    ESP_RETURN_ON_ERROR(send_report(modifier, keys, key_delay_ms), TAG, "hid key press failed");
    ESP_RETURN_ON_ERROR(send_report(0, no_keys, key_delay_ms), TAG, "hid key release failed");
    return ESP_OK;
}

static esp_err_t type_ascii_char(char ch, uint16_t key_delay_ms)
{
    ascii_key_t key = {0};
    if (!ascii_key_for_char(ch, &key)) {
        return ESP_ERR_INVALID_ARG;
    }
    return send_key(key.modifier, key.keycode, key_delay_ms);
}

static esp_err_t type_enter(uint16_t key_delay_ms)
{
    return send_key(0, HID_KEY_ENTER, key_delay_ms);
}
```

- [ ] **Step 4: Add the RIB32 line callback**

Add:

```c
static esp_err_t type_rib32_line_cb(const char *line, void *ctx)
{
    hid_write_context_t *write_ctx = (hid_write_context_t *)ctx;
    if (line == NULL || write_ctx == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    for (const char *p = line; *p != '\0'; ++p) {
        esp_err_t err = type_ascii_char(*p, write_ctx->key_delay_ms);
        if (err != ESP_OK) {
            (void)release_all_keys(write_ctx->key_delay_ms);
            write_ctx->error = REMOTE_INPUT_ERR_HID_INPUT_FAILED;
            return err;
        }
    }

    esp_err_t err = type_enter(write_ctx->key_delay_ms);
    if (err != ESP_OK) {
        (void)release_all_keys(write_ctx->key_delay_ms);
        write_ctx->error = REMOTE_INPUT_ERR_HID_INPUT_FAILED;
        return err;
    }
    return ESP_OK;
}
```

- [ ] **Step 5: Pass `task_id` through the writer interface**

In `firmware/components/remote_input_core/include/remote_input_writer.h`, change the writer function pointer from:

```c
    remote_input_error_t (*write_text)(const uint8_t *bytes,
                                       size_t len,
                                       const remote_input_config_t *config,
                                       void *ctx);
```

to:

```c
    remote_input_error_t (*write_text)(uint16_t task_id,
                                       const uint8_t *bytes,
                                       size_t len,
                                       const remote_input_config_t *config,
                                       void *ctx);
```

In `firmware/components/remote_input_device/remote_input_writer_runner.c`, change `write_job()` from:

```c
    return s_writer->write_text(job->bytes, job->len, &job->config, s_writer->ctx);
```

to:

```c
    return s_writer->write_text(job->task_id, job->bytes, job->len, &job->config, s_writer->ctx);
```

- [ ] **Step 6: Change `remote_input_hid_write_text()` to emit RIB32**

Change the function signature from:

```c
remote_input_error_t remote_input_hid_write_text(const uint8_t *bytes,
                                                 size_t len,
                                                 const remote_input_config_t *config,
                                                 void *ctx)
```

to:

```c
remote_input_error_t remote_input_hid_write_text(uint16_t task_id,
                                                 const uint8_t *bytes,
                                                 size_t len,
                                                 const remote_input_config_t *config,
                                                 void *ctx)
```

Replace the second `remote_input_utf8_decode_each()` call and callback loop with:

```c
    hid_write_context_t write_ctx = {
        .error = REMOTE_INPUT_ERR_OK,
        .key_delay_ms = key_delay_ms,
    };

    esp_err_t err = remote_input_rib32_emit(task_id, bytes, len, type_rib32_line_cb, &write_ctx);
    if (err != ESP_OK) {
        if (write_ctx.error != REMOTE_INPUT_ERR_OK) {
            return write_ctx.error;
        }
        if (err == ESP_ERR_INVALID_ARG) {
            return REMOTE_INPUT_ERR_INVALID_COMMAND;
        }
        return REMOTE_INPUT_ERR_HID_INPUT_FAILED;
    }
```

- [ ] **Step 7: Verify no Alt+Unicode path remains**

Run:

```bash
rg -n "Alt|alt|codepoint|EnableHexNumpad|KEYPAD_ADD|remote_input_hid_type_codepoint" firmware sdk docs
```

Expected: no remaining references to the deleted Alt+Unicode input behavior, except `remote_input_utf8` codepoint validation names if still needed by UTF-8 internals.

- [ ] **Step 8: Build firmware**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS and `firmware/build/remote_input.bin` exists.

- [ ] **Step 9: Commit**

```bash
git add firmware/components/remote_input_device/remote_input_hid.c firmware/components/remote_input_device/include/remote_input_hid.h firmware/components/remote_input_core/include/remote_input_writer.h firmware/components/remote_input_device/remote_input_writer_runner.c
git commit -m "feat: type rib32 frames over hid"
```

---

### Task 5: Documentation and Full Verification

**Files:**
- Modify: `docs/remote-input-protocol.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces final documented behavior and verification evidence.

- [ ] **Step 1: Update protocol documentation**

In `docs/remote-input-protocol.md`, replace step 10-11 in the normal flow:

```markdown
10. ESP32 将 UTF-8 解码为 Unicode code point。
11. ESP32 通过 USB HID 逐个输入 code point。
```

with:

```markdown
10. ESP32 校验完整 payload 是否为合法 UTF-8。
11. ESP32 将原始 UTF-8 字节编码为 RIB32 ASCII 文本帧。
12. ESP32 通过 USB HID 把 RIB32 帧逐行输入到目标设备的 `decode.html`。
13. `decode.html` 校验分块和整篇 CRC32，通过后显示可复制的原始文本。
```

Add a new section before "后续传输扩展":

```markdown
## 9. USB HID RIB32 输出格式

RIB32 是 ESP32-S3 到目标浏览器页面的 ASCII 输出格式，独立于 BLE/WebSocket 二进制协议版本。当前 RIB32 格式版本为 `1`。

目标设备应打开 `sdk/decode.html`，并把光标放在 RIB32 输入框内。ESP32-S3 不再依赖 Windows `EnableHexNumpad`，也不再使用 `Alt` + Unicode 码点输入。

每个数据分块一行：

```text
<RIB32:1:taskId:chunkIndex:chunkTotal:payloadCrc:payload>
```

每个任务以结束行收尾：

```text
</RIB32:1:taskId:messageCrc>
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `taskId` | 原输入任务 ID，十进制 |
| `chunkIndex` | 从 0 开始的分块序号 |
| `chunkTotal` | 分块总数 |
| `payloadCrc` | 当前分块原始字节的 CRC32，8 位大写十六进制 |
| `payload` | RFC 4648 Base32，无 `=` padding |
| `messageCrc` | 完整 UTF-8 原始字节的 CRC32，8 位大写十六进制 |

当前每个 RIB32 分块承载 32 字节原始 UTF-8 数据。网页只在所有分块存在、每块 CRC32 正确、整篇 CRC32 正确且 UTF-8 解码成功后显示最终文本。单个字符错误只会让对应分块或整篇校验失败，不会输出乱码文本。
```

Renumber the old "后续传输扩展" section from `## 9` to `## 10`.

- [ ] **Step 2: Search and update stale wording**

Run:

```bash
rg -n "EnableHexNumpad|Alt|Unicode code point|code point|逐个输入|码点" docs sdk firmware
```

Expected: remaining matches are either about UTF-8 parser internals or clearly state that Alt+Unicode is old behavior removed by RIB32.

- [ ] **Step 3: Run SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS.

- [ ] **Step 4: Run firmware build**

Run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Expected: PASS and `firmware/build/remote_input.bin` exists.

- [ ] **Step 5: Inspect git diff**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` has no output. `git status --short` lists only intended source, test, doc, and lockfile changes.

- [ ] **Step 6: Commit**

```bash
git add docs/remote-input-protocol.md docs/firmware-architecture.md
git commit -m "docs: document rib32 hid output"
```

Because this plan only requires `docs/remote-input-protocol.md`, use this commit command when `docs/firmware-architecture.md` has no relevant stale wording:

```bash
git add docs/remote-input-protocol.md
git commit -m "docs: document rib32 hid output"
```

## Manual Validation Not Run By Agent

The implementation agent must report these as not executed unless a separate hardware-capable environment performs them:

- Flash ESP32-S3 firmware.
- Open `sdk/decode.html` on the target device.
- Focus the RIB32 input area.
- Send Chinese text from the SDK page.
- Confirm ESP32-S3 types RIB32 frame lines into the decoder page.
- Confirm decoded Chinese appears only after all checks pass.
- Copy decoded text and paste it into the final target app.
- Corrupt one typed character and confirm the decoder reports the bad chunk or message CRC instead of showing garbled text.
