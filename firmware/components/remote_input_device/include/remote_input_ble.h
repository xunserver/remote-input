#pragma once

#include "esp_err.h"
#include "remote_input_protocol.h"
#include "remote_input_status.h"

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

esp_err_t remote_input_ble_init(const remote_input_ble_callbacks_t *callbacks);
void remote_input_ble_notify_status(void);
