# Base32 HID Decoder Design

## Goal

Remote Input should stop using Windows `Alt` + Unicode codepoint input at the USB HID writer layer. Instead, ESP32-S3 should type a robust ASCII transfer format into a browser page on the target device. The browser page decodes the typed Base32 data back into the original UTF-8 text, including Chinese text, and lets the user copy and paste the decoded result into the final target application.

The design must prevent one mistyped character from corrupting the whole text. Each new input task must start a new logical section, and the decoder must detect missing, damaged, duplicated, or conflicting chunks.

## Scope

In scope:

- Remove the current `Alt` + Unicode input path from the firmware HID writer.
- Add a firmware ASCII frame encoder for HID output.
- Add a standalone target-side decoder page at `sdk/decode.html`.
- Add a reusable SDK parser/decoder module for the typed frame format.
- Add automated SDK tests for encoding, parsing, decoding, and error isolation.
- Update demo copy and protocol documentation.

Out of scope:

- Changing the existing SDK-to-ESP32 BLE/WebSocket binary protocol.
- Adding forward error correction or fountain-code retransmission.
- Automatically pasting decoded text into arbitrary target applications.
- Hardware flashing, serial monitoring, or real USB HID validation in the agent environment.

## Current Behavior

The SDK sends UTF-8 text to ESP32-S3 over the existing protocol v2 BLE or WebSocket transport. The firmware receives the full task, validates UTF-8, decodes the bytes into Unicode codepoints, and uses USB HID keyboard reports to type each codepoint via Windows `Alt` + numpad `+` + hexadecimal codepoint. This requires Windows `EnableHexNumpad` support and is fragile for target environments that do not accept that input method.

## Proposed Behavior

The SDK-to-device transport remains unchanged: the browser SDK still sends UTF-8 text to ESP32-S3 using the current binary protocol.

After ESP32-S3 receives and validates a complete text task, the USB HID writer encodes the original UTF-8 bytes into RIB32 text frames and types those ASCII frames into the currently focused target browser page. The target browser page is `sdk/decode.html`. It parses typed lines, validates each chunk independently, reconstructs complete tasks by `taskId`, and displays a copyable decoded text only after all integrity checks pass.

## RIB32 Text Frame Format

RIB32 is the ASCII HID output format. Its format version is independent from the existing BLE/WebSocket binary protocol version.

Each data chunk is one line:

```text
<RIB32:1:taskId:chunkIndex:chunkTotal:payloadCrc:payload>
```

Each task ends with one end line:

```text
</RIB32:1:taskId:messageCrc>
```

Fields:

- `RIB32`: fixed magic prefix.
- `1`: RIB32 text frame format version.
- `taskId`: decimal task id copied from the received input task.
- `chunkIndex`: decimal zero-based chunk index.
- `chunkTotal`: decimal total chunk count.
- `payloadCrc`: eight uppercase hexadecimal CRC32 of the decoded raw bytes for this chunk.
- `payload`: RFC 4648 Base32 encoding of the chunk's raw UTF-8 bytes, using alphabet `A-Z2-7` and no `=` padding.
- `messageCrc`: eight uppercase hexadecimal CRC32 of all original UTF-8 bytes joined in chunk order.

The initial payload chunk size should be `32` raw bytes. This produces about `52` Base32 characters per chunk, keeping each HID-typed line short enough for visual inspection and localizing errors. The size should be a named constant so it can be tuned later without changing the frame grammar.

The firmware types one frame per line. It sends `Enter` after each chunk line and after the end line.

## Decoder Page

Add `sdk/decode.html` as a standalone page intended to be opened on the target device. It contains:

- A focused text input area for receiving HID-typed RIB32 frames.
- A task list that groups parsed frames by `taskId`.
- Per-task progress and error state.
- A decoded output area that appears only when the task is complete and valid.
- A copy button for the decoded text.

The page should parse incrementally as text arrives. It may update chunk status in real time, but it must only present a complete decoded result after:

- The end frame is present.
- All chunks from `0` to `chunkTotal - 1` are present.
- Every chunk line is syntactically valid.
- Every chunk Base32 payload decodes successfully.
- Every chunk CRC32 matches.
- The assembled UTF-8 bytes pass `TextDecoder` fatal UTF-8 decoding.
- The assembled message CRC32 matches the end frame.

The page should retain multiple historical tasks. A new `taskId` creates or updates a separate section rather than overwriting earlier decoded results.

## SDK Module

Add a reusable module, `sdk/src/base32Frame.ts`, for the decoder page and tests. It should own:

- RFC 4648 Base32 encode/decode without padding.
- CRC32 calculation using the standard polynomial.
- RIB32 line formatting.
- RIB32 line parsing.
- Per-task aggregation and status derivation.
- UTF-8 final decoding.

The page should keep UI logic separate from this parser module. This keeps format behavior testable without a browser.

## Firmware Components

The existing `remote_input_core` abstraction remains unchanged. It still receives UTF-8 bytes and submits them to a writer. The RIB32 encoder belongs in `remote_input_device` because it is part of this device's USB HID output strategy.

Firmware changes:

- Remove `remote_input_hid_type_codepoint()` and the helper path that holds `Alt`, sends keypad `+`, and types hexadecimal codepoints.
- Keep UTF-8 validation in `remote_input_hid_write_text()`.
- Add ASCII key mapping for the RIB32 character set and frame punctuation:
  - uppercase letters `A-Z`
  - digits used by task ids, chunk indexes, totals, and CRC fields
  - Base32 digits `2-7`
  - punctuation `<`, `>`, `/`, `:`
  - `Enter`
- Encode each validated task into RIB32 chunk lines and one end line.
- Return existing writer errors:
  - `USB_NOT_READY` when the USB HID device is not ready.
  - `INVALID_UTF8` when incoming bytes are not valid UTF-8.
  - `HID_INPUT_FAILED` when HID report transmission fails.

`INVALID_CODEPOINT` remains in the public error enum for compatibility, but the new writer should not normally emit it because RIB32 can represent all valid UTF-8 bytes.

## Error Isolation Rules

The decoder must not let one bad character corrupt following content.

Chunk handling rules:

- A malformed chunk line records a syntax error for that line.
- An invalid Base32 payload records an error for that chunk.
- A chunk CRC mismatch records an error for that chunk.
- A missing chunk is reported by index after an end frame is seen.
- A repeated chunk with a valid CRC may replace an earlier invalid chunk.
- If two valid chunks with the same `taskId` and `chunkIndex` contain different bytes, the task enters a conflict state for that index.
- Frames for different `taskId` values are isolated.
- A bad end-frame message CRC prevents final decoded output but preserves per-chunk status.

Only a fully valid task produces copyable decoded text.

## Documentation Updates

Update `docs/remote-input-protocol.md` to clarify:

- The existing BLE/WebSocket binary protocol remains protocol version `2`.
- RIB32 is a separate USB HID output text format with version `1`.
- The target device should open `sdk/decode.html`.
- Windows `EnableHexNumpad` is no longer required.
- Hardware validation still requires a real target browser and USB HID path.

Update `sdk/index.html` copy to remove the EnableHexNumpad requirement and tell the user to focus `decode.html` on the target device before sending.

## Testing

Add SDK tests in `sdk/tests/base32-frame.test.js`, covering:

- Chinese, English, emoji, and mixed newline text round trips.
- Empty text.
- Text close to the maximum supported SDK payload size.
- Out-of-order chunk lines.
- A single corrupted Base32 character causing only that chunk to fail.
- Missing chunk reporting.
- Duplicate chunk handling.
- Conflicting valid chunks.
- Bad message CRC in the end frame.
- Multiple consecutive tasks with different task ids.

Run:

```bash
npm --prefix sdk run test:sdk
```

For firmware changes, run:

```bash
eim run "idf.py -C firmware -B firmware/build build"
```

Manual hardware validation remains required outside the agent environment:

- Open `sdk/decode.html` on the target device.
- Focus the decoder input area.
- Send text through ESP32-S3.
- Confirm RIB32 frames are typed into the page.
- Confirm the decoded Chinese text appears only after all checks pass.
- Copy the decoded text and paste it into the final target application.
- Manually corrupt one typed character and confirm the page identifies the bad chunk instead of displaying garbled decoded text.

## Acceptance Criteria

- Firmware no longer depends on Windows `Alt` + Unicode input.
- ESP32-S3 HID output consists only of RIB32 ASCII frames and line breaks.
- `sdk/decode.html` decodes valid RIB32 frames back to the original UTF-8 text.
- Decoder errors are localized to specific chunks or task-level checksum failures.
- Existing SDK-to-ESP32 BLE/WebSocket protocol behavior remains compatible.
- SDK automated tests pass.
- Firmware build succeeds.
