#include "remote_input_display.h"

#include "esp_check.h"
#include "esp_log.h"

#include "freertos/FreeRTOS.h"

#include "lvgl.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>

#define REMOTE_INPUT_DISPLAY_WIDTH_PCT 100
#define REMOTE_INPUT_DISPLAY_LABEL_GAP 16

static const char *TAG = "remote_input_display";

static lv_obj_t *s_root;
static lv_obj_t *s_ble_label;
static lv_obj_t *s_input_label;
static lv_obj_t *s_version_label;
static bool s_initialized;
static bool s_ble_connected;
static remote_input_state_t s_input_state;
static bool s_flush_pending;
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;

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
    s_ble_connected = false;
    s_input_state = REMOTE_INPUT_STATE_IDLE;
    s_flush_pending = false;
}

static void delete_root_if_present(void)
{
    if (s_root != NULL) {
        lv_obj_del(s_root);
    }

    reset_handles();
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

static void flush_status_labels(void *user_data)
{
    (void)user_data;

    bool initialized;
    bool ble_connected;
    remote_input_state_t input_state;

    portENTER_CRITICAL(&s_state_lock);
    initialized = s_initialized;
    ble_connected = s_ble_connected;
    input_state = s_input_state;
    s_flush_pending = false;
    portEXIT_CRITICAL(&s_state_lock);

    if (!initialized || s_ble_label == NULL || s_input_label == NULL) {
        return;
    }

    lv_label_set_text(s_ble_label, ble_connected ? "BLE: Connected" : "BLE: Waiting");
    lv_label_set_text(s_input_label, input_state_text(input_state));
}

static void request_async_flush(void)
{
    bool should_request = false;

    portENTER_CRITICAL(&s_state_lock);
    if (s_initialized && !s_flush_pending) {
        s_flush_pending = true;
        should_request = true;
    }
    portEXIT_CRITICAL(&s_state_lock);

    if (!should_request) {
        return;
    }

    if (lv_async_call(flush_status_labels, NULL) != LV_RES_OK) {
        portENTER_CRITICAL(&s_state_lock);
        s_flush_pending = false;
        portEXIT_CRITICAL(&s_state_lock);
        ESP_LOGW(TAG, "failed to request async display flush");
    }
}

esp_err_t remote_input_display_init(const char *version)
{
    delete_root_if_present();

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
        delete_root_if_present();
        return ESP_ERR_NO_MEM;
    }

    portENTER_CRITICAL(&s_state_lock);
    s_initialized = true;
    s_ble_connected = false;
    s_input_state = REMOTE_INPUT_STATE_IDLE;
    s_flush_pending = false;
    portEXIT_CRITICAL(&s_state_lock);
    return ESP_OK;
}

void remote_input_display_set_ble_connected(bool connected)
{
    bool initialized;

    portENTER_CRITICAL(&s_state_lock);
    initialized = s_initialized;
    if (initialized) {
        s_ble_connected = connected;
    }
    portEXIT_CRITICAL(&s_state_lock);

    if (initialized) {
        request_async_flush();
    }
}

void remote_input_display_set_input_state(remote_input_state_t state)
{
    bool initialized;

    portENTER_CRITICAL(&s_state_lock);
    initialized = s_initialized;
    if (initialized) {
        s_input_state = state;
    }
    portEXIT_CRITICAL(&s_state_lock);

    if (initialized) {
        request_async_flush();
    }
}
