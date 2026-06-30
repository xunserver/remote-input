# Firmware ESP-IDF Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the firmware to a clearer ESP-IDF component structure without changing runtime behavior.

**Architecture:** `main` becomes a small boot entry. `ai_input_core` contains protocol and pure logic. `ai_input_device` contains NimBLE, TinyUSB HID, and a service module that coordinates the application workflow.

**Tech Stack:** ESP-IDF 6.x, NimBLE, TinyUSB HID, FreeRTOS, CMake.

---

### Task 1: Move Core Logic Into `ai_input_core`

**Files:**
- Create: `firmware/components/ai_input_core/CMakeLists.txt`
- Create: `firmware/components/ai_input_core/include/`
- Move: `firmware/main/ai_input_protocol.*`
- Move: `firmware/main/ai_input_status.*`
- Move: `firmware/main/ai_input_task.*`
- Move: `firmware/main/ai_input_utf8.*`

- [ ] Move the listed source files from `firmware/main` to `firmware/components/ai_input_core`.
- [ ] Move the listed public headers to `firmware/components/ai_input_core/include`.
- [ ] Register the component with `idf_component_register`.

### Task 2: Move Device Logic Into `ai_input_device`

**Files:**
- Create: `firmware/components/ai_input_device/CMakeLists.txt`
- Create: `firmware/components/ai_input_device/include/`
- Move: `firmware/main/ai_input_ble.*`
- Move: `firmware/main/ai_input_hid.*`

- [ ] Move BLE and HID sources into `firmware/components/ai_input_device`.
- [ ] Move BLE and HID headers into `firmware/components/ai_input_device/include`.
- [ ] Register dependencies on `ai_input_core`, `bt`, `nvs_flash`, `esp_tinyusb`, and `tinyusb`.

### Task 3: Extract Application Service

**Files:**
- Create: `firmware/components/ai_input_device/include/ai_input_service.h`
- Create: `firmware/components/ai_input_device/ai_input_service.c`
- Modify: `firmware/main/app_main.c`

- [ ] Move the current receive/task/typing orchestration from `app_main.c` into `ai_input_service.c`.
- [ ] Expose `esp_err_t ai_input_service_init(void)`.
- [ ] Keep `app_main.c` limited to logging startup, calling `ai_input_service_init()`, and logging readiness.

### Task 4: Update Main Component

**Files:**
- Modify: `firmware/main/CMakeLists.txt`

- [ ] Register only `app_main.c`.
- [ ] Add `REQUIRES ai_input_device`.

### Task 5: Verify

**Files:**
- No source changes.

- [ ] Run `node tests/sdk-protocol.test.js`.
- [ ] Run `idf.py -C firmware build` if ESP-IDF is available.
- [ ] Report any unavailable tool separately from source errors.
