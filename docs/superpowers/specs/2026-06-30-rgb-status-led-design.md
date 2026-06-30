# RGB Status LED Design

## Context

The target board is Waveshare ESP32-S3-LCD-1.47. Its onboard RGB LED is controlled through GPIO38. The current firmware already tracks BLE connection events and remote input task state, but it does not expose local visual feedback on the board.

The goal is to add a small hardware-specific LED module that shows the current high-level device state without changing the BLE protocol or USB HID input behavior.

## Requirements

The firmware shall show exactly three LED states:

| Device condition | LED behavior |
| --- | --- |
| No BLE device connected | Red, solid |
| BLE device connected and no active typing | Green, solid |
| USB HID typing in progress | Blue, fast blink |

Typing has priority over connection state:

```text
TYPING > CONNECTED_IDLE > WAITING_CONNECTION
```

If the BLE device disconnects while typing is still in progress, the LED shall keep blinking blue until typing ends, then switch to solid red.

## Non-Goals

- Do not change the BLE protocol.
- Do not add LED state to the SDK status frame.
- Do not make LED failures block BLE or HID functionality.
- Do not add extra visual states for errors, receiving, or USB-not-ready in this iteration.
- Do not implement display-screen UI for this board.

## Proposed Approach

Add a hardware-specific LED module under the existing device component:

```text
firmware/components/remote_input_device/
  remote_input_led.c
  include/remote_input_led.h
```

This module owns GPIO38 RGB LED initialization, color output, and blink timing. It stays in `remote_input_device` because the pin number and LED driver are board-specific concerns, not protocol-core concerns.

## Public Interface

The module exposes simple state-oriented calls:

```c
typedef enum {
    REMOTE_INPUT_LED_WAITING_CONNECTION,
    REMOTE_INPUT_LED_CONNECTED_IDLE,
    REMOTE_INPUT_LED_TYPING,
} remote_input_led_mode_t;

esp_err_t remote_input_led_init(void);
void remote_input_led_set_connected(bool connected);
void remote_input_led_set_typing(bool typing);
```

Callers do not choose final colors directly. The module internally stores:

```c
static bool s_connected;
static bool s_typing;
```

It derives the effective mode as:

```text
if s_typing:
    REMOTE_INPUT_LED_TYPING
else if s_connected:
    REMOTE_INPUT_LED_CONNECTED_IDLE
else:
    REMOTE_INPUT_LED_WAITING_CONNECTION
```

## Integration Points

`remote_input_service_init()` shall initialize the LED module. Initial state is no BLE connection, so the LED shall become solid red after successful LED initialization.

BLE connection events shall update connection state:

```text
BLE connect success
  -> remote_input_led_set_connected(true)

BLE disconnect
  -> remote_input_led_set_connected(false)
```

Typing events shall update typing state:

```text
Before run_typing_task starts HID input
  -> remote_input_led_set_typing(true)

Before run_typing_task returns, for DONE or ERROR paths
  -> remote_input_led_set_typing(false)
```

The service should clear typing state on every exit path from `run_typing_task()`. A single cleanup path is preferred so error returns do not leave the LED stuck in blue blink mode.

## Driver Design

Use an ESP-IDF-supported RGB LED driver path based on RMT/LED strip support for the GPIO38 single-wire RGB LED. The implementation should avoid hand-written timing loops because RGB LED timing is sensitive to task scheduling.

Suggested brightness values:

| Mode | RGB |
| --- | --- |
| Waiting connection | `(32, 0, 0)` |
| Connected idle | `(0, 32, 0)` |
| Typing blink on | `(0, 0, 48)` |
| Typing blink off | `(0, 0, 0)` |

The blue fast blink interval should be 150 ms on and 150 ms off.

## Concurrency

BLE callbacks and the typing worker run in different FreeRTOS task contexts. The LED module shall protect shared state with a small critical section, for example a `portMUX_TYPE`.

The LED module shall run its own task:

```text
remote_input_led_task
```

State update functions shall:

1. Update `s_connected` or `s_typing`.
2. Recompute the effective mode.
3. Notify the LED task.

The LED task shall:

- Set solid red for waiting connection.
- Set solid green for connected idle.
- Blink blue while typing.
- Wake promptly when notified so mode changes do not wait for the next blink delay.

## Error Handling

LED is auxiliary. Failure to initialize or update the LED shall not break remote input.

Rules:

- If LED initialization fails, log with `ESP_LOGE` and continue starting BLE/HID.
- If a color update fails, log the error and keep the current firmware flow.
- Do not return LED errors from BLE callbacks or typing logic.

## Verification

Manual firmware verification:

1. Flash the firmware to ESP32-S3-LCD-1.47.
2. Boot with no Web Bluetooth connection.
   - Expected: red solid.
3. Connect from the web UI.
   - Expected: green solid.
4. Send text.
   - Expected: blue fast blink during HID typing.
5. Wait for completion.
   - Expected: green solid if still connected.
6. Disconnect the web UI.
   - Expected: red solid.
7. Send a longer text and disconnect during typing.
   - Expected: blue blink continues until typing ends, then red solid.

Build verification:

```text
idf.py -C firmware build
```

Unit-test coverage is not required for hardware LED output in this iteration, but the implementation should keep state derivation small enough to test later if needed.
