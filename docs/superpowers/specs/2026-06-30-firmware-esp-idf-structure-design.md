# Firmware ESP-IDF Structure Design

## Goal

Restructure the firmware so the ESP-IDF entry point stays small, reusable logic lives in focused components, and the current BLE protocol and HID behavior remain unchanged.

## Current Issues

- `firmware/main/app_main.c` owns startup, BLE callbacks, task buffering, typing worker logic, status updates, UTF-8 validation, and HID error mapping.
- All firmware code is registered as one `main` component, so component dependencies do not express the real boundaries.
- The pure protocol/task/UTF-8 logic is mixed with ESP-IDF transport code, making host-side testing harder to add later.

## Design

Create two firmware components:

- `ai_input_core`: protocol parsing, status encoding/state, task buffering, and UTF-8 decoding.
- `ai_input_device`: ESP-IDF device-facing code, including NimBLE transport, TinyUSB HID output, and the application service that coordinates core logic with device I/O.

Keep `firmware/main/app_main.c` as the boot entry only. It calls `ai_input_service_init()` and logs startup/readiness.

## Behavior Constraints

- Do not change BLE UUIDs, frame layouts, status frame layout, state codes, or error codes.
- Do not change HID typing behavior or timing.
- Do not change the Web SDK protocol contract.

## Verification

- Run `node tests/sdk-protocol.test.js`.
- Run `idf.py -C firmware build` when ESP-IDF tools are available in the shell.
