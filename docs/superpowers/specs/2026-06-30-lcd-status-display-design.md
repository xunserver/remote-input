# LCD Status Display Design

## Context

The target ESP32-S3 board already has a working LCD and LVGL setup. The current firmware tracks BLE connection events and remote input task state, and it already exposes local feedback through the onboard RGB LED.

The goal is to add a small LVGL status page that shows the most important runtime state directly on the LCD without changing the BLE protocol, USB HID behavior, or the existing LCD/LVGL board initialization.

## Requirements

The firmware shall show one always-visible status screen with exactly three pieces of information:

| Area | Content |
| --- | --- |
| Top | BLE connection state |
| Middle | Current input state |
| Bottom | Firmware version string |

The BLE state shall display one of:

```text
BLE: Waiting
BLE: Connected
```

The input state shall display one of:

```text
Input: Idle
Input: Receiving
Input: Typing
Input: Done
Input: Error
```

The version line shall display a compile-time version string in this format:

```text
Version: 2026.6.1-1
```

The version format is `YYYY.M.D-N`, where `N` is a manually controlled build or release counter.

## Non-Goals

- Do not implement LCD panel initialization.
- Do not implement the LVGL port, tick, flush callback, display driver, or UI task.
- Do not add touch support.
- Do not add pages, menus, animations, or progress detail.
- Do not show task ID, byte progress, or error codes on the LCD in this iteration.
- Do not change the BLE protocol or SDK status frame.
- Do not make display failures block BLE or USB HID functionality.

## Proposed Approach

Add an LVGL display module under the existing device component:

```text
firmware/components/remote_input_device/
  remote_input_display.c
  include/remote_input_display.h
```

This module owns only the status page widgets and display text updates. It stays in `remote_input_device` because it depends on board UI infrastructure and is not part of the protocol core.

The module assumes LVGL is already initialized by board-level code before `remote_input_display_init()` is called. It shall not configure LCD GPIOs, panel timing, backlight, LVGL ticks, or LVGL driver callbacks.

## Public Interface

The display module exposes a small state-oriented API:

```c
esp_err_t remote_input_display_init(const char *version);
void remote_input_display_set_ble_connected(bool connected);
void remote_input_display_set_input_state(remote_input_state_t state);
```

`remote_input_display_init()` creates the status screen and stores the LVGL label handles. The `version` argument is copied into the version label. If `version` is `NULL` or empty, the module shall display a clear fallback value such as:

```text
Version: unknown
```

Callers do not pass raw label text. The module maps firmware state to user-facing text internally.

## Layout

The first implementation shall use a simple vertical layout:

```text
+----------------------+
| BLE: Waiting         |
|                      |
| Input: Idle          |
|                      |
| Version: 2026.6.1-1  |
+----------------------+
```

The exact font size and alignment may follow the existing LVGL style used by the board project. The layout should prefer readability over decoration. If the screen is small, labels may use compact default LVGL fonts, but all three lines must remain visible at the same time.

## Data Flow

`remote_input_service.c` remains the state orchestration layer.

Startup flow:

1. Initialize `remote_input_status`.
2. Initialize local visual outputs, including the existing LED module and the new display module.
3. Pass the compile-time firmware version string to `remote_input_display_init()`.
4. Continue initializing HID and BLE.

BLE flow:

- On BLE connect, call `remote_input_led_set_connected(true)` and `remote_input_display_set_ble_connected(true)`.
- On BLE disconnect, call `remote_input_led_set_connected(false)` and `remote_input_display_set_ble_connected(false)`.
- If there is no active typing task after disconnect, set the input state back to `REMOTE_INPUT_STATE_IDLE` and update the display.

Input flow:

- Whenever the service sets `REMOTE_INPUT_STATE_RECEIVING`, `REMOTE_INPUT_STATE_TYPING`, `REMOTE_INPUT_STATE_DONE`, or `REMOTE_INPUT_STATE_ERROR`, it also calls `remote_input_display_set_input_state(state)`.
- The LCD uses only the state enum. It ignores task ID, byte counts, and error details.

## Firmware Version Source

The version string shall be a compile-time constant, for example:

```c
#define REMOTE_INPUT_FIRMWARE_VERSION "2026.6.1-1"
```

The implementation plan may choose the narrowest repository-consistent way to provide this constant, such as a generated config macro, a CMake compile definition, or a small project version header. The string must be easy to update for release builds and must not be derived from BLE protocol version.

## LVGL Threading and Safety

The module must respect the LVGL calling model used by the existing board code.

If the project already has a UI task, LVGL lock, or UI dispatch helper, `remote_input_display` shall use that existing mechanism for label creation and updates.

If no shared mechanism exists, the module shall introduce a minimal internal boundary so BLE callbacks and typing worker code do not directly mutate LVGL objects from unsafe contexts. The implementation should keep this boundary local to `remote_input_display` unless the existing LCD code shows a better established pattern.

## Error Handling

The LCD status page is auxiliary. Failure to initialize or update it shall not stop BLE advertising, BLE connection handling, or USB HID input.

Failure cases shall be handled as follows:

- If display initialization fails, log an error and leave the module disabled.
- If a label cannot be created, clean up any labels already created and return an error from init.
- If an update function is called before successful init, it shall safely no-op.
- If an unknown input state is received, display `Input: Error` or `Input: Unknown` and log a warning.

## Testing and Verification

Build verification:

```powershell
idf.py -C firmware -B build_codex_check build
```

Hardware verification on the ESP32-S3 LCD board:

1. Flash the firmware.
2. On boot before BLE connection, verify the screen shows `BLE: Waiting`, `Input: Idle`, and the configured version string.
3. Connect from the browser SDK demo and verify the screen changes to `BLE: Connected`.
4. Send input and verify the screen changes to `Input: Typing`.
5. After input completes, verify the screen changes to `Input: Done`.
6. Disconnect BLE and verify the screen changes to `BLE: Waiting`; if no input task is active, verify `Input: Idle`.

## Acceptance Criteria

- The firmware builds successfully.
- The new display module is isolated from BLE protocol and HID implementation details.
- The LCD shows BLE state, simplified input state, and compile-time firmware version at the same time.
- Display initialization or update failure does not break the remote input core behavior.
- The implementation does not add progress, task ID, or error-code display in this iteration.
