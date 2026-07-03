# Decoder SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a first-class RIB32 decoder SDK API and a standalone `remote-input-decoder.js` bundle used by `decode.html`.

**Architecture:** Keep `sdk/src/base32Frame.ts` as the pure RIB32 protocol core. Add `sdk/src/decoder.ts` for browser/application decoder state, input binding, snapshots, reset, and completion events. Add `sdk/src/decoderBundle.ts` as the decoder-only IIFE entry while `sdk/src/index.ts` continues to be the main SDK entry.

**Tech Stack:** TypeScript, Vite library build, IIFE bundles, Node `assert`, `tsx`, DOM-like test fakes.

## Global Constraints

- Do not change the RIB32 text frame format.
- Do not change the BLE/WebSocket SDK-to-ESP32 protocol.
- Do not change firmware HID output behavior.
- Do not add automatic paste into arbitrary target applications.
- Do not run hardware validation in the agent environment.
- Preserve TypeScript ES modules and two-space indentation.
- SDK validation command: `npm --prefix sdk run test:sdk`.
- Static decoder deployments must include `decode.html`, `styles.css`, and `dist/remote-input-decoder.js`.

---

## File Structure

- Create `sdk/src/decoder.ts`: reusable decoder SDK layer above `base32Frame.ts`.
- Create `sdk/src/decoderBundle.ts`: decoder-only bundle entry that re-exports decoder APIs and pure RIB32 helpers.
- Modify `sdk/src/index.ts`: export decoder APIs from the main SDK and include them in `RemoteInput`.
- Modify `sdk/package.json`: run the main SDK build and decoder bundle build in sequence.
- Modify `sdk/vite.config.ts`: keep the main SDK IIFE build.
- Create `sdk/vite.decoder.config.ts`: emit the decoder-only `remote-input-decoder.js` IIFE bundle without deleting the main SDK bundle.
- Modify `sdk/decode.html`: load `dist/remote-input-decoder.js` and use the decoder SDK for input handling.
- Modify `sdk/tests/base32-frame.test.js`: import decoder APIs and test programmatic/input-binding behavior.
- Modify `sdk/tests/sdk-protocol.test.js`: verify new bundle config, globals, and HTML wiring.
- Modify `docs/remote-input-protocol.md`: document the decoder bundle deployment shape.

---

### Task 1: Add Decoder SDK API

**Files:**
- Create: `sdk/src/decoder.ts`
- Modify: `sdk/tests/base32-frame.test.js`

**Interfaces:**
- Consumes:
  - `createRib32DecoderState(): Rib32DecoderState`
  - `ingestRib32Text(state: Rib32DecoderState, text: string): Rib32DecoderState`
  - `getRib32Tasks(state: Rib32DecoderState): Rib32TaskView[]`
  - `getRib32LineErrors(state: Rib32DecoderState): string[]`
  - `formatRib32Frames(taskId: number, bytes: Uint8Array): string[]`
- Produces:
  - `type Rib32DecoderSnapshot = { tasks: Rib32TaskView[]; lineErrors: string[]; buffer: string }`
  - `type Rib32DecoderUpdate = { snapshot: Rib32DecoderSnapshot; completedTasks: Rib32TaskView[] }`
  - `type Rib32InputDecoderOptions = { onUpdate?: (update: Rib32DecoderUpdate) => void; onComplete?: (task: Rib32TaskView) => void }`
  - `class RemoteInputDecoder`
  - `function createRib32InputDecoder(options?: Rib32InputDecoderOptions): RemoteInputDecoder`

- [ ] **Step 1: Add failing decoder API tests**

Append this block to `sdk/tests/base32-frame.test.js` after the existing tests:

```js
const {
  RemoteInputDecoder,
  createRib32InputDecoder,
} = require("../src/decoder.ts");

class FakeTextInput {
  constructor() {
    this.value = "";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) {
      this.listeners.delete(type);
    }
  }

  emit(type) {
    const listener = this.listeners.get(type);
    if (listener) listener({ target: this });
  }
}

{
  const completed = [];
  const updates = [];
  const decoder = createRib32InputDecoder({
    onUpdate: (update) => updates.push(update),
    onComplete: (task) => completed.push(task),
  });
  const lines = formatRib32Frames(21, encoder.encode("decoder sdk"));

  const partial = decoder.ingest(`${lines[0].slice(0, 8)}`);
  assert.equal(partial.snapshot.buffer, lines[0].slice(0, 8));
  assert.equal(partial.snapshot.tasks.length, 0);

  const update = decoder.ingest(`${lines[0].slice(8)}\n${lines[1]}\n`);
  assert.equal(update.snapshot.tasks.length, 1);
  assert.equal(update.snapshot.tasks[0].status, "complete");
  assert.equal(update.snapshot.tasks[0].decodedText, "decoder sdk");
  assert.equal(update.completedTasks.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].taskId, 21);
  assert.equal(updates.at(-1).snapshot.tasks[0].decodedText, "decoder sdk");

  const repeated = decoder.ingest("");
  assert.equal(repeated.completedTasks.length, 0);

  decoder.reset();
  assert.deepEqual(decoder.snapshot(), { tasks: [], lineErrors: [], buffer: "" });
}

{
  const decoder = new RemoteInputDecoder();
  const input = new FakeTextInput();
  const unbind = decoder.bindTextInput(input);
  const lines = formatRib32Frames(22, encoder.encode("bound input"));

  input.value = `${lines[0]}\n${lines[1]}\n`;
  input.emit("input");

  assert.equal(input.value, "");
  assert.equal(decoder.snapshot().tasks[0].decodedText, "bound input");

  input.value = "<RIB32";
  input.emit("input");
  assert.equal(input.value, "<RIB32");
  assert.equal(decoder.snapshot().buffer, "<RIB32");

  unbind();
  input.value = `${input.value}:ignored`;
  input.emit("input");
  assert.equal(decoder.snapshot().buffer, "<RIB32");
}

{
  const decoder = new RemoteInputDecoder();
  const input = new FakeTextInput();
  decoder.bindTextInput(input);
  decoder.destroy();

  input.value = "<RIB32";
  input.emit("input");
  assert.equal(decoder.snapshot().buffer, "");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: FAIL because `../src/decoder.ts` does not exist.

- [ ] **Step 3: Create `sdk/src/decoder.ts`**

Create `sdk/src/decoder.ts`:

```ts
import {
  createRib32DecoderState,
  getRib32LineErrors,
  getRib32Tasks,
  ingestRib32Text,
} from "./base32Frame";
import type { Rib32DecoderState, Rib32TaskView } from "./base32Frame";

export type Rib32DecoderSnapshot = {
  tasks: Rib32TaskView[];
  lineErrors: string[];
  buffer: string;
};

export type Rib32DecoderUpdate = {
  snapshot: Rib32DecoderSnapshot;
  completedTasks: Rib32TaskView[];
};

export type Rib32InputDecoderOptions = {
  onUpdate?: (update: Rib32DecoderUpdate) => void;
  onComplete?: (task: Rib32TaskView) => void;
};

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

type Binding = {
  input: TextInputElement;
  listener: () => void;
};

export class RemoteInputDecoder {
  private state: Rib32DecoderState;
  private completedTaskIds: Set<number>;
  private bindings: Set<Binding>;
  private options: Rib32InputDecoderOptions;

  constructor(options: Rib32InputDecoderOptions = {}) {
    this.state = createRib32DecoderState();
    this.completedTaskIds = new Set();
    this.bindings = new Set();
    this.options = options;
  }

  ingest(text: string): Rib32DecoderUpdate {
    ingestRib32Text(this.state, text);
    return this.emitUpdate();
  }

  snapshot(): Rib32DecoderSnapshot {
    return {
      tasks: getRib32Tasks(this.state),
      lineErrors: getRib32LineErrors(this.state),
      buffer: this.state.buffer,
    };
  }

  reset(): Rib32DecoderUpdate {
    this.state = createRib32DecoderState();
    this.completedTaskIds.clear();
    return this.emitUpdate();
  }

  bindTextInput(input: TextInputElement): () => void {
    let processedLength = input.value.length;
    const listener = () => {
      const newText = input.value.slice(processedLength);
      const update = this.ingest(newText);
      input.value = update.snapshot.buffer;
      processedLength = input.value.length;
    };
    const binding = { input, listener };
    this.bindings.add(binding);
    input.addEventListener("input", listener);
    return () => {
      input.removeEventListener("input", listener);
      this.bindings.delete(binding);
    };
  }

  destroy(): void {
    for (const binding of this.bindings) {
      binding.input.removeEventListener("input", binding.listener);
    }
    this.bindings.clear();
  }

  private emitUpdate(): Rib32DecoderUpdate {
    const snapshot = this.snapshot();
    const completedTasks = snapshot.tasks.filter((task) => {
      if (task.status !== "complete" || this.completedTaskIds.has(task.taskId)) {
        return false;
      }
      this.completedTaskIds.add(task.taskId);
      return true;
    });
    const update = { snapshot, completedTasks };
    this.options.onUpdate?.(update);
    for (const task of completedTasks) {
      this.options.onComplete?.(task);
    }
    return update;
  }
}

export function createRib32InputDecoder(options: Rib32InputDecoderOptions = {}): RemoteInputDecoder {
  return new RemoteInputDecoder(options);
}
```

- [ ] **Step 4: Run tests to verify decoder API passes**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS for the new decoder tests. Existing protocol tests may still pass because the public entry and bundle have not changed yet.

- [ ] **Step 5: Commit decoder API**

Run:

```bash
git add sdk/src/decoder.ts sdk/tests/base32-frame.test.js
git commit -m "feat: add rib32 decoder sdk api"
```

---

### Task 2: Export Decoder API and Build Decoder Bundle

**Files:**
- Create: `sdk/src/decoderBundle.ts`
- Modify: `sdk/src/index.ts`
- Modify: `sdk/package.json`
- Modify: `sdk/vite.config.ts`
- Create: `sdk/vite.decoder.config.ts`
- Modify: `sdk/tests/sdk-protocol.test.js`

**Interfaces:**
- Consumes:
  - `RemoteInputDecoder`
  - `createRib32InputDecoder`
  - all existing RIB32 helper exports from `sdk/src/base32Frame.ts`
- Produces:
  - main SDK global exports `RemoteInputDecoder` and `createRib32InputDecoder`
  - decoder-only global `window.RemoteInputDecoder`
  - build outputs `dist/remote-input-sdk.js` and `dist/remote-input-decoder.js`

- [ ] **Step 1: Update failing bundle and global tests**

In `sdk/tests/sdk-protocol.test.js`, replace the Vite config assertions near the top with:

```js
const packageJson = fs.readFileSync("package.json", "utf8");
assert.match(packageJson, /"build:sdk":\s*"vite build && vite build --config vite\.decoder\.config\.ts"/);

const viteConfig = fs.readFileSync("vite.config.ts", "utf8");
assert.match(viteConfig, /defineConfig/);
assert.match(viteConfig, /entry:\s*resolve\(__dirname,\s*"src\/index\.ts"\)/);
assert.match(viteConfig, /name:\s*"RemoteInput"/);
assert.match(viteConfig, /formats:\s*\["iife"\]/);
assert.match(viteConfig, /fileName:\s*\(\)\s*=>\s*"remote-input-sdk\.js"/);
assert.match(viteConfig, /outDir:\s*"dist"/);
assert.doesNotMatch(viteConfig, /emptyOutDir:\s*false/);

const decoderViteConfig = fs.readFileSync("vite.decoder.config.ts", "utf8");
assert.match(decoderViteConfig, /defineConfig/);
assert.match(decoderViteConfig, /entry:\s*resolve\(__dirname,\s*"src\/decoderBundle\.ts"\)/);
assert.match(decoderViteConfig, /name:\s*"RemoteInputDecoder"/);
assert.match(decoderViteConfig, /formats:\s*\["iife"\]/);
assert.match(decoderViteConfig, /fileName:\s*\(\)\s*=>\s*"remote-input-decoder\.js"/);
assert.match(decoderViteConfig, /outDir:\s*"dist"/);
assert.match(decoderViteConfig, /emptyOutDir:\s*false/);
```

After the existing assertions for `remoteInputGlobal.getRib32LineErrors`, add:

```js
assert.equal(typeof remoteInputGlobal.RemoteInputDecoder, "function");
assert.equal(typeof remoteInputGlobal.createRib32InputDecoder, "function");
assert.equal(remoteInputGlobal.RemoteInput.RemoteInputDecoder, remoteInputGlobal.RemoteInputDecoder);
assert.equal(remoteInputGlobal.RemoteInput.createRib32InputDecoder, remoteInputGlobal.createRib32InputDecoder);
```

After the `remoteInputGlobal.RIB32_CHUNK_BYTES` assertion, add:

```js
const decoderSource = fs.readFileSync("dist/remote-input-decoder.js", "utf8");
const decoderContext = {
  window: {},
  TextDecoder,
  Uint8Array,
};
vm.createContext(decoderContext);
vm.runInContext(decoderSource, decoderContext);

const decoderGlobal = decoderContext.window.RemoteInputDecoder || decoderContext.RemoteInputDecoder;
assert.equal(typeof decoderGlobal.RemoteInputDecoder, "function");
assert.equal(typeof decoderGlobal.createRib32InputDecoder, "function");
assert.equal(typeof decoderGlobal.formatRib32Frames, "function");
assert.equal(typeof decoderGlobal.ingestRib32Text, "function");
assert.equal(decoderGlobal.RIB32_VERSION, 1);
assert.equal(decoderGlobal.RIB32_CHUNK_BYTES, 32);
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: FAIL because `vite.decoder.config.ts`, `remote-input-decoder.js`, `decoderBundle.ts`, and main SDK decoder exports are missing.

- [ ] **Step 3: Create decoder bundle entry**

Create `sdk/src/decoderBundle.ts`:

```ts
export {
  RemoteInputDecoder,
  createRib32InputDecoder,
} from "./decoder";
export type {
  Rib32DecoderSnapshot,
  Rib32DecoderUpdate,
  Rib32InputDecoderOptions,
} from "./decoder";
export {
  RIB32_CHUNK_BYTES,
  RIB32_VERSION,
  base32Decode,
  base32Encode,
  crc32,
  createRib32DecoderState,
  formatRib32Frames,
  getRib32LineErrors,
  getRib32Tasks,
  ingestRib32Text,
} from "./base32Frame";
export type {
  Rib32DecoderState,
  Rib32TaskStatus,
  Rib32TaskView,
} from "./base32Frame";
```

- [ ] **Step 4: Export decoder APIs from main SDK**

Modify `sdk/src/index.ts` to add these exports after the existing RIB32 exports:

```ts
export {
  RemoteInputDecoder,
  createRib32InputDecoder,
} from "./decoder";
export type {
  Rib32DecoderSnapshot,
  Rib32DecoderUpdate,
  Rib32InputDecoderOptions,
} from "./decoder";
```

Add this import block next to the other imports:

```ts
import { RemoteInputDecoder, createRib32InputDecoder } from "./decoder";
```

Add these fields to `RemoteInput`:

```ts
  RemoteInputDecoder,
  createRib32InputDecoder,
```

Do not add the decoder class to `_internals`; it is a public API, not an internal test helper.

- [ ] **Step 5: Update `package.json` build script**

In `sdk/package.json`, replace:

```json
"build:sdk": "vite build"
```

with:

```json
"build:sdk": "vite build && vite build --config vite.decoder.config.ts"
```

- [ ] **Step 6: Keep main Vite config as the SDK bundle**

Ensure `sdk/vite.config.ts` remains:

```ts
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "RemoteInput",
      formats: ["iife"],
      fileName: () => "remote-input-sdk.js",
    },
    outDir: "dist",
    sourcemap: false,
  },
});
```

- [ ] **Step 7: Add decoder Vite config**

Create `sdk/vite.decoder.config.ts`:

```ts
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/decoderBundle.ts"),
      name: "RemoteInputDecoder",
      formats: ["iife"],
      fileName: () => "remote-input-decoder.js",
    },
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
  },
});
```

- [ ] **Step 8: Run build to check Vite output**

Run:

```bash
npm --prefix sdk run build:sdk
```

Expected: PASS and files exist:

```text
sdk/dist/remote-input-sdk.js
sdk/dist/remote-input-decoder.js
```

- [ ] **Step 9: Run full SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS.

- [ ] **Step 10: Commit bundle exports**

Run:

```bash
git add sdk/package.json sdk/src/index.ts sdk/src/decoderBundle.ts sdk/vite.config.ts sdk/vite.decoder.config.ts sdk/tests/sdk-protocol.test.js
git commit -m "feat: build decoder sdk bundle"
```

---

### Task 3: Move Decode Page to Decoder SDK

**Files:**
- Modify: `sdk/decode.html`
- Modify: `sdk/tests/sdk-protocol.test.js`

**Interfaces:**
- Consumes:
  - browser global `RemoteInputDecoder.createRib32InputDecoder(options)`
  - update shape `{ snapshot: { tasks, lineErrors, buffer }, completedTasks }`
- Produces:
  - `decode.html` loads `./dist/remote-input-decoder.js`
  - `decode.html` no longer imports `./src/base32Frame.ts`
  - page input handling delegated to decoder SDK

- [ ] **Step 1: Update failing HTML wiring tests**

In `sdk/tests/sdk-protocol.test.js`, replace the `decodeHtml` assertions with:

```js
const decodeHtml = fs.readFileSync("decode.html", "utf8");
assert.match(decodeHtml, /<title>Remote Input Decoder<\/title>/);
assert.match(decodeHtml, /src="\.\/dist\/remote-input-decoder\.js"/);
assert.doesNotMatch(decodeHtml, /\.\/src\/base32Frame\.ts/);
assert.doesNotMatch(decodeHtml, /let processedLength = 0;/);
assert.doesNotMatch(decodeHtml, /slice\(processedLength\)/);
assert.match(decodeHtml, /createRib32InputDecoder/);
assert.match(decodeHtml, /id="rib32Input"/);
assert.match(decodeHtml, /id="taskList"/);
assert.match(decodeHtml, /id="lineErrorList"/);
assert.match(decodeHtml, /Vite dev server|部署后的静态文件/i);
assert.match(decodeHtml, /US\/English/i);
assert.match(decodeHtml, /输入法组合状态|输入法/i);
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: FAIL because `decode.html` still imports `./src/base32Frame.ts` and owns `processedLength`.

- [ ] **Step 3: Replace the inline module script in `decode.html`**

In `sdk/decode.html`, replace:

```html
  <script type="module">
    import { createRib32DecoderState, getRib32LineErrors, getRib32Tasks, ingestRib32Text } from "./src/base32Frame.ts";
```

with:

```html
  <script src="./dist/remote-input-decoder.js"></script>
  <script>
```

Replace the setup lines:

```js
    let state = createRib32DecoderState();
    let processedLength = 0;
```

with:

```js
    const decoderSdk = window.RemoteInputDecoder;
    let latestSnapshot = { tasks: [], lineErrors: [], buffer: "" };
```

Replace the top of `render()`:

```js
      const tasks = getRib32Tasks(state);
      const lineErrors = getRib32LineErrors(state);
```

with:

```js
      const { tasks, lineErrors } = latestSnapshot;
```

Delete this entire block:

```js
    input.addEventListener("input", () => {
      const newText = input.value.slice(processedLength);
      ingestRib32Text(state, newText);
      input.value = state.buffer;
      processedLength = input.value.length;
      render();
    });
```

Add this block before the clear button listener:

```js
    const decoder = decoderSdk.createRib32InputDecoder({
      onUpdate: (update) => {
        latestSnapshot = update.snapshot;
        render();
      },
    });
    decoder.bindTextInput(input);
```

Replace the clear button listener body:

```js
      state = createRib32DecoderState();
      input.value = "";
      processedLength = 0;
      render();
      input.focus();
```

with:

```js
      input.value = "";
      latestSnapshot = decoder.reset().snapshot;
      render();
      input.focus();
```

- [ ] **Step 4: Update decoder page hint text**

In `sdk/decode.html`, replace the hint sentence:

```html
请通过 Vite dev server 或部署后的 Vite 页面访问此页；不要直接以 file:// 或原始静态源文件方式打开当前 HTML。
```

with:

```html
请通过 Vite dev server 或部署后的静态文件访问此页；部署时需要同时提供 dist/remote-input-decoder.js。
```

Keep the existing keyboard layout, Caps Lock, and IME guidance.

- [ ] **Step 5: Run SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS.

- [ ] **Step 6: Commit decode page migration**

Run:

```bash
git add sdk/decode.html sdk/tests/sdk-protocol.test.js
git commit -m "feat: use decoder sdk in decode page"
```

---

### Task 4: Update Protocol Documentation

**Files:**
- Modify: `docs/remote-input-protocol.md`
- Modify: `sdk/tests/sdk-protocol.test.js`

**Interfaces:**
- Consumes:
  - decoder bundle output `dist/remote-input-decoder.js`
  - page files `decode.html` and `styles.css`
- Produces:
  - protocol docs no longer claim source-module imports are the reason raw static access is unsupported
  - docs explain decoder static deployment files

- [ ] **Step 1: Update failing documentation assertions**

In `sdk/tests/sdk-protocol.test.js`, after:

```js
assert.match(protocolDoc, /Vite dev server|Vite 页面/);
```

add:

```js
assert.match(protocolDoc, /dist\/remote-input-decoder\.js/);
assert.match(protocolDoc, /decode\.html.*styles\.css|styles\.css.*decode\.html/s);
assert.doesNotMatch(protocolDoc, /直接引用了开发源码模块/);
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: FAIL because the protocol doc still mentions direct source module imports and does not mention the decoder bundle deployment files.

- [ ] **Step 3: Update protocol doc workflow references**

In `docs/remote-input-protocol.md`, update step 11 from:

```markdown
11. ESP32 通过 USB HID 把 RIB32 帧逐行输入到目标设备通过 Vite dev server 或部署后的 Vite 页面访问的 `decode.html`。
```

to:

```markdown
11. ESP32 通过 USB HID 把 RIB32 帧逐行输入到目标设备通过 Vite dev server 或部署后的静态页面访问的 `decode.html`。
```

- [ ] **Step 4: Update section 9 runtime guidance**

In section `## 9. USB HID RIB32 输出格式`, replace:

```markdown
目标设备应通过 Vite dev server 或部署后的 Vite 页面打开 `sdk/decode.html`，不要直接以 `file://` 或原始静态源文件方式打开当前 HTML，因为页面直接引用了开发源码模块。使用前应把目标设备切换到 US/English 键盘布局，关闭 Caps Lock，并关闭会拦截 ASCII 标点的输入法组合状态，然后把光标放在 RIB32 输入框内。
```

with:

```markdown
目标设备应通过 Vite dev server 或部署后的静态文件打开 `sdk/decode.html`。部署静态文件时，需要同时提供 `decode.html`、`styles.css` 和 `dist/remote-input-decoder.js`。使用前应把目标设备切换到 US/English 键盘布局，关闭 Caps Lock，并关闭会拦截 ASCII 标点的输入法组合状态，然后把光标放在 RIB32 输入框内。
```

- [ ] **Step 5: Update manual validation bullet**

Replace the manual validation bullet:

```markdown
- 目标设备通过 `npm --prefix sdk run dev` 提供的 Vite dev server，或部署后的同等 Vite 页面，打开 `decode.html`；不要直接以 `file://` 或原始静态源文件方式打开。
```

with:

```markdown
- 目标设备通过 `npm --prefix sdk run dev` 提供的 Vite dev server，或部署后的静态页面打开 `decode.html`；静态部署时确认同目录可访问 `styles.css` 和 `dist/remote-input-decoder.js`。
```

- [ ] **Step 6: Run SDK tests**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS.

- [ ] **Step 7: Commit documentation update**

Run:

```bash
git add docs/remote-input-protocol.md sdk/tests/sdk-protocol.test.js
git commit -m "docs: document decoder sdk deployment"
```

---

### Task 5: Final Verification

**Files:**
- Verify all files changed in Tasks 1-4.

**Interfaces:**
- Consumes:
  - decoder SDK API
  - decoder bundle
  - migrated decode page
  - updated docs
- Produces:
  - final verification evidence for handoff

- [ ] **Step 1: Check working tree**

Run:

```bash
git status --short
```

Expected: no uncommitted files.

- [ ] **Step 2: Run full SDK validation**

Run:

```bash
npm --prefix sdk run test:sdk
```

Expected: PASS.

- [ ] **Step 3: Confirm built bundles**

Run:

```bash
ls -l sdk/dist/remote-input-sdk.js sdk/dist/remote-input-decoder.js
```

Expected: both files exist and have non-zero size.

- [ ] **Step 4: Confirm decode page no longer imports source TypeScript**

Run:

```bash
rg -n "\./src/base32Frame\.ts|processedLength" sdk/decode.html
```

Expected: no matches.

- [ ] **Step 5: Confirm docs mention decoder bundle**

Run:

```bash
rg -n "remote-input-decoder|decode\.html|styles\.css" docs/remote-input-protocol.md
```

Expected: output includes `dist/remote-input-decoder.js`, `decode.html`, and `styles.css`.

- [ ] **Step 6: Record hardware validation note**

No command. Final handoff must state that firmware build and hardware HID validation were not run because this is an SDK-only change and current agent environment does not perform hardware validation.
