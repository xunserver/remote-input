# Decoder SDK Design

## Goal

Make the RIB32 decoder a first-class SDK surface instead of keeping browser input handling inside `sdk/decode.html`.

The SDK should expose reusable decoder APIs for applications, and the build should produce a standalone decoder bundle that `decode.html` can load without importing TypeScript source files directly.

## Scope

In scope:

- Add a browser-facing decoder SDK module.
- Keep the existing pure RIB32 parser and formatter behavior compatible.
- Build a standalone `dist/remote-input-decoder.js` bundle.
- Update `decode.html` to use the decoder bundle and keep only UI rendering code.
- Update SDK tests for the new API, bundle output, and HTML wiring.
- Update protocol documentation for the new deployment shape.

Out of scope:

- Changing the RIB32 text frame format.
- Changing the BLE/WebSocket SDK-to-ESP32 protocol.
- Changing firmware HID output behavior.
- Adding automatic paste into arbitrary target applications.
- Running hardware validation in the agent environment.

## Current Behavior

`sdk/src/base32Frame.ts` already owns the pure RIB32 encode/decode logic:

- Base32 encode/decode.
- CRC32.
- RIB32 frame formatting.
- Incremental text ingestion.
- Per-task aggregation and final UTF-8 decoding.

`sdk/src/index.ts` exports those functions, and the IIFE SDK bundle exposes them. However, `sdk/decode.html` still directly imports `./src/base32Frame.ts` and owns browser-specific input state:

- `processedLength`.
- The `<textarea>` `input` listener.
- Feeding appended text into `ingestRib32Text()`.
- Replacing the textarea value with `state.buffer`.
- Resetting state and refocusing the input.

That means the decoder page works well in the Vite development path, but the page-level decoder behavior is not reusable as an SDK API and the page still depends on source-module loading.

## Proposed Behavior

Add a new decoder SDK layer above the existing pure parser.

The new layer should:

- Provide a programmatic decoder object for applications.
- Provide optional binding to an `HTMLInputElement` or `HTMLTextAreaElement`.
- Own incremental input bookkeeping currently embedded in `decode.html`.
- Emit stable snapshots for UI rendering.
- Be exported from the main SDK entry.
- Also be built as a small standalone IIFE bundle for decoder-only pages.

The existing `base32Frame.ts` behavior remains the protocol core. The new decoder module should call those functions rather than duplicating parsing, CRC, or UTF-8 logic.

## API Design

Create `sdk/src/decoder.ts`.

Suggested exports:

```ts
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

export class RemoteInputDecoder {
  constructor(options?: Rib32InputDecoderOptions);
  ingest(text: string): Rib32DecoderUpdate;
  snapshot(): Rib32DecoderSnapshot;
  reset(): Rib32DecoderUpdate;
  bindTextInput(input: HTMLInputElement | HTMLTextAreaElement): () => void;
  destroy(): void;
}

export function createRib32InputDecoder(options?: Rib32InputDecoderOptions): RemoteInputDecoder;
```

`ingest(text)` appends text to the internal RIB32 state and returns a snapshot update.

`snapshot()` returns the current tasks, line errors, and partial line buffer without mutating state.

`reset()` clears decoder state and emits an update.

`bindTextInput(input)` attaches an `input` event listener. It should return an unsubscribe function and should also be tracked by `destroy()`.

The input binding should preserve the current page behavior:

- Listen to the element's `input` event.
- Read only newly appended text.
- Ingest that text.
- Replace the element value with the decoder's partial line buffer.
- Keep internal processed length consistent with the updated element value.

The input binding is intentionally based on text changes rather than `keydown` or `keyup`, because ESP32-S3 acts as a USB HID keyboard and browsers already convert those HID reports into textarea text.

## Completion Events

The decoder should avoid repeatedly firing `onComplete` for the same completed task.

Implementation should track completed task IDs and emit a completion only when a task first transitions to `complete`.

If a future conflicting line turns a previously completed task into `error`, `snapshot()` should show the current error state. Completion callbacks are historical notifications and should not imply immutable task validity.

## Bundle Design

Keep the existing main SDK bundle:

```text
sdk/dist/remote-input-sdk.js
```

Add a decoder-only bundle:

```text
sdk/dist/remote-input-decoder.js
```

The decoder bundle should expose a global object:

```js
window.RemoteInputDecoder
```

The global should include:

- `RemoteInputDecoder`
- `createRib32InputDecoder`
- pure RIB32 helpers that are useful for testing or integrations:
  - `RIB32_VERSION`
  - `RIB32_CHUNK_BYTES`
  - `base32Encode`
  - `base32Decode`
  - `crc32`
  - `formatRib32Frames`
  - `createRib32DecoderState`
  - `ingestRib32Text`
  - `getRib32Tasks`
  - `getRib32LineErrors`

The main SDK entry should also export the new decoder class and factory.

## Decode Page

Update `sdk/decode.html` so it no longer imports `./src/base32Frame.ts`.

The page should load the standalone bundle:

```html
<script src="./dist/remote-input-decoder.js"></script>
```

The inline page script should:

- Create a decoder with an `onUpdate` callback.
- Bind the decoder to `#rib32Input`.
- Render from `update.snapshot.tasks` and `update.snapshot.lineErrors`.
- Reset the decoder and input when the clear button is clicked.
- Keep the current copy button behavior.
- Keep focusing the input on initial load and after clear.

The page remains responsible only for UI rendering and clipboard actions.

## Documentation

Update `docs/remote-input-protocol.md` to describe the new deployment requirement:

- `decode.html` uses the built decoder bundle instead of importing TypeScript source directly.
- Static deployments must include `decode.html`, `styles.css`, and `dist/remote-input-decoder.js`.
- Vite dev server remains supported for development.
- The target device must still use US/English keyboard layout, Caps Lock off, and no IME composition mode that rewrites ASCII punctuation.

Remove or replace the old statement that the page must not be opened as raw static HTML specifically because it imports development source modules. A raw `file://` workflow may still be limited by browser behavior, but direct TypeScript source-module loading should no longer be the reason.

## Testing

Add or extend SDK tests to cover:

- `RemoteInputDecoder.ingest()` completes a valid task.
- `snapshot()` exposes tasks, line errors, and partial buffer.
- `reset()` clears all decoder state.
- Completion callbacks fire once per completed task.
- `bindTextInput()` responds to `input` events and leaves only the partial line buffer in the input value.
- `destroy()` detaches bound input listeners.
- `dist/remote-input-decoder.js` exposes `window.RemoteInputDecoder`.
- `decode.html` references `dist/remote-input-decoder.js` and no longer imports `./src/base32Frame.ts`.

Continue running:

```bash
npm --prefix sdk run test:sdk
```

Firmware build is not required for this SDK-only change unless implementation unexpectedly touches firmware files.

## Acceptance Criteria

- `decode.html` no longer imports TypeScript source modules directly.
- The decoder page uses an SDK-provided input decoder API.
- `npm --prefix sdk run build:sdk` emits both SDK and decoder bundles.
- The main SDK exports the decoder API.
- The decoder-only bundle exposes a usable `window.RemoteInputDecoder` global.
- Existing RIB32 parser tests continue to pass.
- New decoder API and bundle tests pass.
- Protocol documentation reflects the new decoder deployment shape.
