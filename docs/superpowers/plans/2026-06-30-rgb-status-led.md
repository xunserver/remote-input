# RGB Status LED Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add RGB LED feedback on Waveshare ESP32-S3-LCD-1.47: red while waiting for BLE connection, green while connected and idle, and blue fast blink during HID typing.

**Architecture:** Add a focused `remote_input_led` module inside `remote_input_device`. The module owns GPIO38 LED strip initialization, LED state derivation, and blink timing; BLE/service code only reports connection and typing state.

**Tech Stack:** ESP-IDF, FreeRTOS tasks/notifications, ESP-IDF `led_strip` component over RMT, existing NimBLE and TinyUSB firmware.

---

## File Structure

- Create `firmware/components/remote_input_device/include/remote_input_led.h`
  - Public LED state API for device code.
- Create `firmware/components/remote_input_device/remote_input_led.c`
  - GPIO38 LED initialization, mode derivation, LED task, color output, blue fast blink.
- Modify `firmware/components/remote_input_device/CMakeLists.txt`
  - Compile `remote_input_led.c` and add required dependencies.
- Modify `firmware/main/idf_component.yml`
  - Add `espressif/led_strip` dependency.
- Modify `firmware/components/remote_input_device/include/remote_input_ble.h`
  - Add BLE connect callback type.
- Modify `firmware/components/remote_input_device/remote_input_ble.c`
  - Notify service when BLE connects.
- Modify `firmware/components/remote_input_device/remote_input_service.c`
  - Initialize LED module and update connected/typing state at existing lifecycle points.

---

## Task 1: Add LED Module Interface

**Files:**
- Create: `firmware/components/remote_input_device/include/remote_input_led.h`

- [ ] **Step 1: Create the public LED header**

Create `firmware/components/remote_input_device/include/remote_input_led.h` with:

```c
#pragma once

#include <stdbool.h>

#include "esp_err.h"

typedef enum {
    REMOTE_INPUT_LED_WAITING_CONNECTION = 0,
    REMOTE_INPUT_LED_CONNECTED_IDLE = 1,
    REMOTE_INPUT_LED_TYPING = 2,
} remote_input_led_mode_t;

esp_err_t remote_input_led_init(void);
void remote_input_led_set_connected(bool connected);
void remote_input_led_set_typing(bool typing);
```

- [ ] **Step 2: Commit the interface**

Run:

```powershell
git add firmware\components\remote_input_device\include\remote_input_led.h
git commit -m "feat: add rgb led interface"
```

Expected: commit succeeds.

---

## Task 2: Implement LED Driver Module

**Files:**
- Create: `firmware/components/remote_input_device/remote_input_led.c`
- Modify: `firmware/components/remote_input_device/CMakeLists.txt`
- Modify: `firmware/main/idf_component.yml`

- [ ] **Step 1: Add the LED strip dependency**

In `firmware/main/idf_component.yml`, add `espressif/led_strip` next to `esp_tinyusb`:

```yaml
dependencies:
  idf:
    version: '>=4.1.0'
  espressif/esp_tinyusb: '*'
  espressif/led_strip: '*'
```

- [ ] **Step 2: Register the new source and dependency**

Update `firmware/components/remote_input_device/CMakeLists.txt` so it includes the new source and `led_strip` requirement:

```cmake
idf_component_register(
    SRCS
        "remote_input_ble.c"
        "remote_input_hid.c"
        "remote_input_led.c"
        "remote_input_service.c"
    INCLUDE_DIRS "include"
    REQUIRES
        remote_input_core
        bt
        nvs_flash
        esp_tinyusb
        tinyusb
        led_strip
    PRIV_REQUIRES freertos
)
```

- [ ] **Step 3: Implement `remote_input_led.c`**

Create `firmware/components/remote_input_device/remote_input_led.c`:

```c
#include "remote_input_led.h"

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"

#define REMOTE_INPUT_LED_GPIO 38
#define REMOTE_INPUT_LED_COUNT 1
#define REMOTE_INPUT_LED_RMT_RESOLUTION_HZ (10 * 1000 * 1000)
#define REMOTE_INPUT_LED_TASK_STACK_SIZE 2048
#define REMOTE_INPUT_LED_TASK_PRIORITY 3
#define REMOTE_INPUT_LED_BLINK_MS 150

static const char *TAG = "remote_input_led";

static led_strip_handle_t s_led_strip;
static TaskHandle_t s_led_task_handle;
static portMUX_TYPE s_led_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_connected;
static bool s_typing;
static remote_input_led_mode_t s_mode = REMOTE_INPUT_LED_WAITING_CONNECTION;
static bool s_initialized;

static remote_input_led_mode_t derive_mode_locked(void)
{
    if (s_typing) {
        return REMOTE_INPUT_LED_TYPING;
    }
    if (s_connected) {
        return REMOTE_INPUT_LED_CONNECTED_IDLE;
    }
    return REMOTE_INPUT_LED_WAITING_CONNECTION;
}

static remote_input_led_mode_t get_mode(void)
{
    remote_input_led_mode_t mode;

    portENTER_CRITICAL(&s_led_lock);
    mode = s_mode;
    portEXIT_CRITICAL(&s_led_lock);

    return mode;
}

static void set_pixel(uint8_t red, uint8_t green, uint8_t blue)
{
    if (!s_initialized || s_led_strip == NULL) {
        return;
    }

    esp_err_t err = led_strip_set_pixel(s_led_strip, 0, red, green, blue);
    if (err == ESP_OK) {
        err = led_strip_refresh(s_led_strip);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "failed to update led: %s", esp_err_to_name(err));
    }
}

static void set_solid_for_mode(remote_input_led_mode_t mode)
{
    switch (mode) {
    case REMOTE_INPUT_LED_WAITING_CONNECTION:
        set_pixel(32, 0, 0);
        break;
    case REMOTE_INPUT_LED_CONNECTED_IDLE:
        set_pixel(0, 32, 0);
        break;
    case REMOTE_INPUT_LED_TYPING:
        set_pixel(0, 0, 48);
        break;
    default:
        set_pixel(0, 0, 0);
        break;
    }
}

static void notify_led_task(void)
{
    if (s_led_task_handle != NULL) {
        xTaskNotifyGive(s_led_task_handle);
    }
}

static void update_state(bool connected, bool typing, bool update_connected, bool update_typing)
{
    bool changed = false;

    portENTER_CRITICAL(&s_led_lock);
    if (update_connected && s_connected != connected) {
        s_connected = connected;
        changed = true;
    }
    if (update_typing && s_typing != typing) {
        s_typing = typing;
        changed = true;
    }
    if (changed) {
        s_mode = derive_mode_locked();
    }
    portEXIT_CRITICAL(&s_led_lock);

    if (changed) {
        notify_led_task();
    }
}

static void led_task(void *ctx)
{
    (void)ctx;

    bool blink_on = false;
    remote_input_led_mode_t applied_solid_mode = (remote_input_led_mode_t)-1;

    for (;;) {
        const remote_input_led_mode_t mode = get_mode();

        if (mode == REMOTE_INPUT_LED_TYPING) {
            blink_on = !blink_on;
            if (blink_on) {
                set_pixel(0, 0, 48);
            } else {
                set_pixel(0, 0, 0);
            }
            applied_solid_mode = (remote_input_led_mode_t)-1;
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(REMOTE_INPUT_LED_BLINK_MS));
            continue;
        }

        if (applied_solid_mode != mode) {
            set_solid_for_mode(mode);
            applied_solid_mode = mode;
        }
        blink_on = false;
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    }
}

esp_err_t remote_input_led_init(void)
{
    led_strip_config_t strip_config = {
        .strip_gpio_num = REMOTE_INPUT_LED_GPIO,
        .max_leds = REMOTE_INPUT_LED_COUNT,
    };
    led_strip_rmt_config_t rmt_config = {
        .resolution_hz = REMOTE_INPUT_LED_RMT_RESOLUTION_HZ,
    };

    ESP_RETURN_ON_ERROR(led_strip_new_rmt_device(&strip_config, &rmt_config, &s_led_strip),
                        TAG,
                        "failed to create led strip");
    ESP_RETURN_ON_ERROR(led_strip_clear(s_led_strip), TAG, "failed to clear led strip");

    portENTER_CRITICAL(&s_led_lock);
    s_connected = false;
    s_typing = false;
    s_mode = REMOTE_INPUT_LED_WAITING_CONNECTION;
    s_initialized = true;
    portEXIT_CRITICAL(&s_led_lock);

    BaseType_t created = xTaskCreate(led_task,
                                     "remote_input_led",
                                     REMOTE_INPUT_LED_TASK_STACK_SIZE,
                                     NULL,
                                     REMOTE_INPUT_LED_TASK_PRIORITY,
                                     &s_led_task_handle);
    if (created != pdPASS) {
        s_led_task_handle = NULL;
        return ESP_ERR_NO_MEM;
    }

    notify_led_task();
    return ESP_OK;
}

void remote_input_led_set_connected(bool connected)
{
    update_state(connected, false, true, false);
}

void remote_input_led_set_typing(bool typing)
{
    update_state(false, typing, false, true);
}
```

- [ ] **Step 4: Build to catch dependency or API issues**

Run:

```powershell
idf.py -C firmware build
```

Expected: build succeeds. If the installed ESP-IDF/`led_strip` version uses a slightly different RMT config field name, adjust only the config initializer to match the installed component API and rebuild.

- [ ] **Step 5: Commit the LED module**

Run:

```powershell
git add firmware\main\idf_component.yml firmware\components\remote_input_device\CMakeLists.txt firmware\components\remote_input_device\remote_input_led.c
git commit -m "feat: add rgb status led driver"
```

Expected: commit succeeds.

---

## Task 3: Add BLE Connect Callback

**Files:**
- Modify: `firmware/components/remote_input_device/include/remote_input_ble.h`
- Modify: `firmware/components/remote_input_device/remote_input_ble.c`

- [ ] **Step 1: Extend BLE callback interface**

In `firmware/components/remote_input_device/include/remote_input_ble.h`, add a connect callback type and field:

```c
typedef void (*remote_input_connect_cb_t)(void);
typedef void (*remote_input_control_cb_t)(const remote_input_control_frame_t *frame);
typedef void (*remote_input_data_cb_t)(const remote_input_data_frame_t *frame);
typedef void (*remote_input_disconnect_cb_t)(void);

typedef struct {
    remote_input_connect_cb_t on_connect;
    remote_input_control_cb_t on_control;
    remote_input_data_cb_t on_data;
    remote_input_disconnect_cb_t on_disconnect;
} remote_input_ble_callbacks_t;
```

- [ ] **Step 2: Notify on successful BLE connection**

In `firmware/components/remote_input_device/remote_input_ble.c`, update the successful `BLE_GAP_EVENT_CONNECT` branch:

```c
case BLE_GAP_EVENT_CONNECT:
    if (event->connect.status == 0) {
        s_conn_handle = event->connect.conn_handle;
        ESP_LOGI(TAG, "connected handle=%u", s_conn_handle);
        if (s_callbacks.on_connect != NULL) {
            s_callbacks.on_connect();
        }
    } else {
        s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        start_advertising();
    }
    return 0;
```

- [ ] **Step 3: Build**

Run:

```powershell
idf.py -C firmware build
```

Expected: build succeeds.

- [ ] **Step 4: Commit BLE callback support**

Run:

```powershell
git add firmware\components\remote_input_device\include\remote_input_ble.h firmware\components\remote_input_device\remote_input_ble.c
git commit -m "feat: report ble connect events"
```

Expected: commit succeeds.

---

## Task 4: Integrate LED State With Service Lifecycle

**Files:**
- Modify: `firmware/components/remote_input_device/remote_input_service.c`

- [ ] **Step 1: Include the LED module**

Add this include near the other local includes in `remote_input_service.c`:

```c
#include "remote_input_led.h"
```

- [ ] **Step 2: Add connect handler**

Add this function near `on_disconnect()`:

```c
static void on_connect(void)
{
    remote_input_led_set_connected(true);
}
```

- [ ] **Step 3: Update disconnect handler**

Change `on_disconnect()` to set LED connection state first:

```c
static void on_disconnect(void)
{
    remote_input_led_set_connected(false);

    if (!is_typing_active()) {
        if (g_task.active) {
            remote_input_status_set(REMOTE_INPUT_STATE_IDLE, 0, REMOTE_INPUT_ERR_OK, 0, 0);
        }
        reset_receive_task();
    }
}
```

- [ ] **Step 4: Add LED cleanup helper for typing**

Add this helper before `run_typing_task()`:

```c
static void finish_typing_with_status(remote_input_state_t state,
                                      uint16_t task_id,
                                      remote_input_error_t error,
                                      size_t len)
{
    remote_input_status_set(state, task_id, error, (uint32_t)len, (uint32_t)len);
    remote_input_ble_notify_status();
    remote_input_led_set_typing(false);
}
```

- [ ] **Step 5: Refactor `run_typing_task()` to always clear typing LED state**

Replace the whole `run_typing_task()` function with:

```c
static void run_typing_task(uint16_t task_id, const uint8_t *bytes, size_t len)
{
    remote_input_led_set_typing(true);
    remote_input_status_set(REMOTE_INPUT_STATE_TYPING, task_id, REMOTE_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);
    remote_input_ble_notify_status();

    bool valid = remote_input_utf8_decode_each(bytes, len, validate_codepoint_cb, NULL);
    if (!valid) {
        finish_typing_with_status(REMOTE_INPUT_STATE_ERROR, task_id, REMOTE_INPUT_ERR_INVALID_UTF8, len);
        return;
    }

    if (!remote_input_hid_ready()) {
        finish_typing_with_status(REMOTE_INPUT_STATE_ERROR, task_id, REMOTE_INPUT_ERR_USB_NOT_READY, len);
        return;
    }

    typing_context_t typing_ctx = {
        .error = REMOTE_INPUT_ERR_OK,
    };
    bool ok = remote_input_utf8_decode_each(bytes, len, type_codepoint_cb, &typing_ctx);
    if (!ok) {
        remote_input_error_t error = typing_ctx.error;
        if (error == REMOTE_INPUT_ERR_OK) {
            error = REMOTE_INPUT_ERR_INVALID_UTF8;
        }
        finish_typing_with_status(REMOTE_INPUT_STATE_ERROR, task_id, error, len);
        return;
    }

    finish_typing_with_status(REMOTE_INPUT_STATE_DONE, task_id, REMOTE_INPUT_ERR_OK, len);
}
```

- [ ] **Step 6: Initialize LED during service startup**

In `remote_input_service_init()`, after `remote_input_task_init(&g_task);`, add:

```c
esp_err_t led_err = remote_input_led_init();
if (led_err != ESP_OK) {
    ESP_LOGE(TAG, "led init failed: %s", esp_err_to_name(led_err));
}
```

Keep continuing startup even when LED initialization fails.

- [ ] **Step 7: Register the connect callback**

Update the callbacks initializer:

```c
const remote_input_ble_callbacks_t callbacks = {
    .on_connect = on_connect,
    .on_control = on_control,
    .on_data = on_data,
    .on_disconnect = on_disconnect,
};
```

- [ ] **Step 8: Build**

Run:

```powershell
idf.py -C firmware build
```

Expected: build succeeds.

- [ ] **Step 9: Commit service integration**

Run:

```powershell
git add firmware\components\remote_input_device\remote_input_service.c
git commit -m "feat: show connection and typing led states"
```

Expected: commit succeeds.

---

## Task 5: Final Verification

**Files:**
- Read: `docs/superpowers/specs/2026-06-30-rgb-status-led-design.md`
- Read: `docs/superpowers/plans/2026-06-30-rgb-status-led.md`

- [ ] **Step 1: Run repository status check**

Run:

```powershell
git status --short
```

Expected: no unexpected modified files. If build artifacts changed, do not commit them unless they are intentionally tracked.

- [ ] **Step 2: Run firmware build**

Run:

```powershell
idf.py -C firmware build
```

Expected: build succeeds.

- [ ] **Step 3: Run SDK protocol tests**

Run:

```powershell
npm test
```

Expected: tests pass. This feature should not change SDK protocol behavior.

- [ ] **Step 4: Manual board verification**

Flash and observe:

```powershell
idf.py -C firmware flash monitor
```

Expected behavior:

1. Boot with no Web Bluetooth connection: LED is solid red.
2. Connect from the web UI: LED is solid green.
3. Send text: LED blinks blue quickly during HID typing.
4. Wait for completion: LED returns to solid green.
5. Disconnect web UI: LED becomes solid red.
6. Send longer text and disconnect during typing: LED stays blue blinking until typing ends, then becomes solid red.

- [ ] **Step 5: Commit plan document if not already committed**

Run:

```powershell
git add docs\superpowers\plans\2026-06-30-rgb-status-led.md
git commit -m "docs: plan rgb status led implementation"
```

Expected: commit succeeds if the plan was not previously committed. If it is already committed, Git reports nothing to commit.

---

## Self-Review Notes

- Spec coverage:
  - Red waiting state: Task 2 LED mode and Task 4 initialization/disconnect integration.
  - Green connected idle: Task 3 connect callback and Task 4 service integration.
  - Blue fast blink during typing: Task 2 blink task and Task 4 typing lifecycle integration.
  - Typing priority over connection: Task 2 `derive_mode_locked()`.
  - Disconnect during typing: Task 2 derived mode plus Task 4 disconnect behavior.
  - LED failures non-blocking: Task 4 startup handles LED init failure without aborting.
- Scope: single firmware feature, no SDK protocol changes.
- Placeholder scan: no TBD/TODO placeholders.
