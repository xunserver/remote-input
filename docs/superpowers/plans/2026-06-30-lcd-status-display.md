# LCD Status Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an LVGL single-screen LCD status panel showing BLE connection state, simplified input state, and compile-time firmware version.

**Architecture:** Add a focused `remote_input_display` module inside `remote_input_device` that owns LVGL labels and exposes state-oriented update functions. Keep `remote_input_service.c` as the state orchestrator and call the display module alongside the existing LED/status updates. Provide the firmware version through a compile-time macro that is independent from BLE protocol version.

**Tech Stack:** ESP-IDF 6.0.1, C, FreeRTOS, LVGL, existing `remote_input_core` and `remote_input_device` components.

---

## File Structure

- Create `firmware/components/remote_input_device/include/remote_input_display.h`
  - Public display API.
  - Includes `remote_input_status.h` for `remote_input_state_t`.

- Create `firmware/components/remote_input_device/remote_input_display.c`
  - Owns LVGL objects for BLE, input, and version labels.
  - Maps firmware states to display strings.
  - Treats update calls before init as safe no-ops.

- Create `firmware/components/remote_input_device/include/remote_input_firmware_version.h`
  - Defines `REMOTE_INPUT_FIRMWARE_VERSION`.
  - Default value: `"2026.6.1-1"`.

- Modify `firmware/components/remote_input_device/CMakeLists.txt`
  - Add `remote_input_display.c` to `SRCS`.
  - Add the repository's LVGL component name to `REQUIRES` or `PRIV_REQUIRES`.
  - Keep existing dependencies unchanged.

- Modify `firmware/components/remote_input_device/remote_input_service.c`
  - Include the new display and version headers.
  - Initialize display after LED initialization.
  - Add a helper to set status, notify BLE, and update LCD consistently.
  - Update BLE connect/disconnect handlers to update the display.

---

## Task 1: Add Firmware Version Header

**Files:**
- Create: `firmware/components/remote_input_device/include/remote_input_firmware_version.h`

- [ ] **Step 1: Create the version header**

Add this file:

```c
#pragma once

#ifndef REMOTE_INPUT_FIRMWARE_VERSION
#define REMOTE_INPUT_FIRMWARE_VERSION "2026.6.1-1"
#endif
```

- [ ] **Step 2: Build to confirm the standalone header is harmless**

Run:

```powershell
idf.py -C firmware -B build_codex_check build
```

Expected:

```text
Project build complete.
```

If the build environment is not active, first run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force; & 'C:\esp\v6.0.1\esp-idf\export.ps1'
```

- [ ] **Step 3: Commit**

```powershell
git add firmware\components\remote_input_device\include\remote_input_firmware_version.h
git commit -m "feat: add firmware version constant"
```

---

## Task 2: Add Display Module API

**Files:**
- Create: `firmware/components/remote_input_device/include/remote_input_display.h`

- [ ] **Step 1: Create the public display header**

Add this file:

```c
#pragma once

#include "remote_input_status.h"

#include "esp_err.h"

#include <stdbool.h>

esp_err_t remote_input_display_init(const char *version);
void remote_input_display_set_ble_connected(bool connected);
void remote_input_display_set_input_state(remote_input_state_t state);
```

- [ ] **Step 2: Build to confirm the header compiles with current include paths**

Run:

```powershell
idf.py -C firmware -B build_codex_check build
```

Expected:

```text
Project build complete.
```

- [ ] **Step 3: Commit**

```powershell
git add firmware\components\remote_input_device\include\remote_input_display.h
git commit -m "feat: add display status interface"
```

---

## Task 3: Implement LVGL Status Page

**Files:**
- Create: `firmware/components/remote_input_device/remote_input_display.c`
- Modify: `firmware/components/remote_input_device/CMakeLists.txt`

- [ ] **Step 1: Add `remote_input_display.c`**

Create `firmware/components/remote_input_device/remote_input_display.c` with:

```c
#include "remote_input_display.h"

#include "esp_check.h"
#include "esp_log.h"

#include "lvgl.h"

#include <stdbool.h>
#include <stddef.h>

#define REMOTE_INPUT_DISPLAY_WIDTH_PCT 100
#define REMOTE_INPUT_DISPLAY_LABEL_GAP 16

static const char *TAG = "remote_input_display";

static lv_obj_t *s_root;
static lv_obj_t *s_ble_label;
static lv_obj_t *s_input_label;
static lv_obj_t *s_version_label;
static bool s_initialized;

static const char *input_state_text(remote_input_state_t state)
{
    switch (state) {
    case REMOTE_INPUT_STATE_IDLE:
        return "Input: Idle";
    case REMOTE_INPUT_STATE_RECEIVING:
        return "Input: Receiving";
    case REMOTE_INPUT_STATE_TYPING:
        return "Input: Typing";
    case REMOTE_INPUT_STATE_DONE:
        return "Input: Done";
    case REMOTE_INPUT_STATE_ERROR:
        return "Input: Error";
    default:
        ESP_LOGW(TAG, "unknown input state: %d", (int)state);
        return "Input: Unknown";
    }
}

static void reset_handles(void)
{
    s_root = NULL;
    s_ble_label = NULL;
    s_input_label = NULL;
    s_version_label = NULL;
    s_initialized = false;
}

static lv_obj_t *create_label(lv_obj_t *parent, const char *text)
{
    lv_obj_t *label = lv_label_create(parent);
    if (label == NULL) {
        return NULL;
    }

    lv_obj_set_width(label, lv_pct(REMOTE_INPUT_DISPLAY_WIDTH_PCT));
    lv_label_set_long_mode(label, LV_LABEL_LONG_CLIP);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(label, text);
    return label;
}

esp_err_t remote_input_display_init(const char *version)
{
    reset_handles();

    s_root = lv_obj_create(lv_scr_act());
    ESP_RETURN_ON_FALSE(s_root != NULL, ESP_ERR_NO_MEM, TAG, "failed to create root object");

    lv_obj_set_size(s_root, lv_pct(100), lv_pct(100));
    lv_obj_center(s_root);
    lv_obj_set_flex_flow(s_root, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(s_root, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_all(s_root, 8, 0);
    lv_obj_set_style_pad_row(s_root, REMOTE_INPUT_DISPLAY_LABEL_GAP, 0);

    s_ble_label = create_label(s_root, "BLE: Waiting");
    s_input_label = create_label(s_root, "Input: Idle");

    const char *display_version = (version != NULL && version[0] != '\0') ? version : "unknown";
    char version_text[48];
    int written = snprintf(version_text, sizeof(version_text), "Version: %s", display_version);
    if (written < 0 || written >= (int)sizeof(version_text)) {
        ESP_LOGW(TAG, "version text truncated");
        version_text[sizeof(version_text) - 1] = '\0';
    }
    s_version_label = create_label(s_root, version_text);

    if (s_ble_label == NULL || s_input_label == NULL || s_version_label == NULL) {
        if (s_root != NULL) {
            lv_obj_del(s_root);
        }
        reset_handles();
        return ESP_ERR_NO_MEM;
    }

    s_initialized = true;
    return ESP_OK;
}

void remote_input_display_set_ble_connected(bool connected)
{
    if (!s_initialized || s_ble_label == NULL) {
        return;
    }

    lv_label_set_text(s_ble_label, connected ? "BLE: Connected" : "BLE: Waiting");
}

void remote_input_display_set_input_state(remote_input_state_t state)
{
    if (!s_initialized || s_input_label == NULL) {
        return;
    }

    lv_label_set_text(s_input_label, input_state_text(state));
}
```

- [ ] **Step 2: Fix missing standard include if needed**

If the compiler reports `snprintf` is undeclared, add this include near the other standard includes:

```c
#include <stdio.h>
```

The preferred final include block should be:

```c
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
```

- [ ] **Step 3: Add source and LVGL dependency to CMake**

Modify `firmware/components/remote_input_device/CMakeLists.txt` to:

```cmake
idf_component_register(
    SRCS
        "remote_input_ble.c"
        "remote_input_display.c"
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
        lvgl
    PRIV_REQUIRES freertos
)
```

If the existing board LVGL component is named differently, use the actual component name that exports `lvgl.h`. Do not add LCD panel or touch dependencies here unless `remote_input_display.c` directly includes their headers.

- [ ] **Step 4: Build and resolve the LVGL dependency name**

Run:

```powershell
idf.py -C firmware -B build_codex_check build
```

Expected:

```text
Project build complete.
```

If CMake fails with a missing `lvgl` component, inspect the board LCD component or `managed_components` directory and replace `lvgl` in `CMakeLists.txt` with the component name that provides `lvgl.h`.

- [ ] **Step 5: Commit**

```powershell
git add firmware\components\remote_input_device\remote_input_display.c firmware\components\remote_input_device\CMakeLists.txt
git commit -m "feat: add lvgl status display"
```

---

## Task 4: Wire Display Updates into Service State Flow

**Files:**
- Modify: `firmware/components/remote_input_device/remote_input_service.c`

- [ ] **Step 1: Include display and version headers**

At the top of `remote_input_service.c`, change the local include block to:

```c
#include "remote_input_service.h"

#include "remote_input_ble.h"
#include "remote_input_display.h"
#include "remote_input_firmware_version.h"
#include "remote_input_hid.h"
#include "remote_input_led.h"
#include "remote_input_status.h"
#include "remote_input_task.h"
#include "remote_input_utf8.h"
```

- [ ] **Step 2: Add a helper for synchronized status updates**

Add this helper after `reset_receive_task()`:

```c
static void update_status(remote_input_state_t state,
                          uint16_t task_id,
                          remote_input_error_t error,
                          uint32_t received,
                          uint32_t total)
{
    remote_input_status_set(state, task_id, error, received, total);
    remote_input_display_set_input_state(state);
    remote_input_ble_notify_status();
}
```

- [ ] **Step 3: Replace status-set plus notify pairs**

Replace each pair of:

```c
remote_input_status_set(...);
remote_input_ble_notify_status();
```

with:

```c
update_status(...);
```

Use these exact replacements in the current file:

```c
update_status(state, task_id, error, (uint32_t)len, (uint32_t)len);
```

inside `finish_typing_with_status()`.

```c
update_status(REMOTE_INPUT_STATE_TYPING, task_id, REMOTE_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);
```

inside `run_typing_task()`.

```c
update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_DEVICE_BUSY, 0, frame->total_bytes);
```

inside the `is_typing_active()` branch in `on_control()`.

```c
update_status(REMOTE_INPUT_STATE_RECEIVING, frame->task_id, REMOTE_INPUT_ERR_OK, 0, frame->total_bytes);
```

inside the successful `REMOTE_INPUT_CONTROL_START` branch.

```c
update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, err, 0, frame->total_bytes);
```

inside the failed `REMOTE_INPUT_CONTROL_START` branch.

```c
update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, err, g_task.received_bytes, frame->total_bytes);
```

inside the failed `REMOTE_INPUT_CONTROL_COMMIT` branch.

```c
update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_DEVICE_BUSY, g_task.received_bytes, frame->total_bytes);
```

inside the failed `reserve_typing_worker()` branch.

```c
update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_DEVICE_BUSY, received_bytes, total_bytes);
```

inside the failed `xQueueSend()` branch.

```c
update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_INVALID_COMMAND, 0, frame->total_bytes);
```

at the end of `on_control()`.

```c
update_status(REMOTE_INPUT_STATE_RECEIVING, frame->task_id, REMOTE_INPUT_ERR_OK, g_task.received_bytes, g_task.total_bytes);
```

inside the successful `on_data()` branch.

```c
update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, err, received, total);
```

inside the failed `on_data()` branch.

- [ ] **Step 4: Update BLE connection callbacks**

Change `on_connect()` to:

```c
static void on_connect(void)
{
    remote_input_led_set_connected(true);
    remote_input_display_set_ble_connected(true);
}
```

Change `on_disconnect()` to:

```c
static void on_disconnect(void)
{
    remote_input_led_set_connected(false);
    remote_input_display_set_ble_connected(false);

    if (!is_typing_active()) {
        if (g_task.active) {
            update_status(REMOTE_INPUT_STATE_IDLE, 0, REMOTE_INPUT_ERR_OK, 0, 0);
        }
        reset_receive_task();
    }
}
```

- [ ] **Step 5: Initialize display during service init**

In `remote_input_service_init()`, after the LED init block and before queue creation, add:

```c
    esp_err_t display_err = remote_input_display_init(REMOTE_INPUT_FIRMWARE_VERSION);
    if (display_err != ESP_OK) {
        ESP_LOGE(TAG, "display init failed: %s", esp_err_to_name(display_err));
    }
```

The surrounding code should become:

```c
    esp_err_t led_err = remote_input_led_init();
    if (led_err != ESP_OK) {
        ESP_LOGE(TAG, "led init failed: %s", esp_err_to_name(led_err));
    }

    esp_err_t display_err = remote_input_display_init(REMOTE_INPUT_FIRMWARE_VERSION);
    if (display_err != ESP_OK) {
        ESP_LOGE(TAG, "display init failed: %s", esp_err_to_name(display_err));
    }

    g_typing_queue = xQueueCreate(REMOTE_INPUT_TYPING_QUEUE_LEN, sizeof(typing_job_t *));
```

- [ ] **Step 6: Ensure no direct status notifications remain in service**

Run:

```powershell
rg -n "remote_input_status_set|remote_input_ble_notify_status" firmware\components\remote_input_device\remote_input_service.c
```

Expected output should only include `remote_input_status_set` and `remote_input_ble_notify_status` inside `update_status()`.

- [ ] **Step 7: Build**

Run:

```powershell
idf.py -C firmware -B build_codex_check build
```

Expected:

```text
Project build complete.
```

- [ ] **Step 8: Commit**

```powershell
git add firmware\components\remote_input_device\remote_input_service.c
git commit -m "feat: show remote input status on lcd"
```

---

## Task 5: Verify Behavior and Documentation Alignment

**Files:**
- Read: `docs/superpowers/specs/2026-06-30-lcd-status-display-design.md`
- Read: `docs/superpowers/plans/2026-06-30-lcd-status-display.md`

- [ ] **Step 1: Run final firmware build**

Run:

```powershell
idf.py -C firmware -B build_codex_check build
```

Expected:

```text
Project build complete.
```

- [ ] **Step 2: Inspect changed files**

Run:

```powershell
git diff --stat HEAD~3..HEAD
```

Expected changed areas:

```text
firmware/components/remote_input_device/CMakeLists.txt
firmware/components/remote_input_device/include/remote_input_display.h
firmware/components/remote_input_device/include/remote_input_firmware_version.h
firmware/components/remote_input_device/remote_input_display.c
firmware/components/remote_input_device/remote_input_service.c
```

- [ ] **Step 3: Hardware smoke test**

Flash the firmware:

```powershell
idf.py -C firmware -B build_codex_check flash
```

Expected LCD states:

```text
BLE: Waiting
Input: Idle
Version: 2026.6.1-1
```

After browser SDK connects:

```text
BLE: Connected
```

While sending input:

```text
Input: Typing
```

After input completes:

```text
Input: Done
```

After BLE disconnects and no input task is active:

```text
BLE: Waiting
Input: Idle
```

- [ ] **Step 4: Commit verification notes if documentation is updated**

If you add any hardware verification notes to docs, commit them:

```powershell
git add docs
git commit -m "docs: record lcd status verification"
```

If no docs are changed, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Single-screen BLE, input, and version display is covered by Tasks 2-4.
- Compile-time version string is covered by Task 1 and Task 4.
- No LCD/LVGL panel initialization is added; Task 3 only uses existing LVGL.
- Display failures are non-blocking; Task 4 logs display init errors and continues.
- No progress, task ID, or error-code LCD display is added.

Placeholder scan:

- The plan has no `TBD` or deferred implementation sections.
- The only conditional item is the LVGL component name in Task 3, because the current repository snapshot does not show the existing LCD/LVGL board component. The task gives the concrete default `lvgl` and exact resolution instruction if the local component uses a different exported name.

Type consistency:

- Public API names match the spec: `remote_input_display_init`, `remote_input_display_set_ble_connected`, and `remote_input_display_set_input_state`.
- Input state type is consistently `remote_input_state_t`.
- Firmware version macro is consistently `REMOTE_INPUT_FIRMWARE_VERSION`.
