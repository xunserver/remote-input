#pragma once

#include "esp_err.h"
#include "ai_input_protocol.h"
#include "ai_input_status.h"

typedef void (*ai_input_control_cb_t)(const ai_input_control_frame_t *frame);
typedef void (*ai_input_data_cb_t)(const ai_input_data_frame_t *frame);
typedef void (*ai_input_disconnect_cb_t)(void);

typedef struct {
    ai_input_control_cb_t on_control;
    ai_input_data_cb_t on_data;
    ai_input_disconnect_cb_t on_disconnect;
} ai_input_ble_callbacks_t;

esp_err_t ai_input_ble_init(const ai_input_ble_callbacks_t *callbacks);
void ai_input_ble_notify_status(void);
