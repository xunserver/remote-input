#pragma once

#include "esp_err.h"
#include "remote_input_protocol.h"
#include "remote_input_status.h"

typedef void (*remote_input_receiver_connect_cb_t)(void *ctx);
typedef void (*remote_input_receiver_control_cb_t)(const remote_input_control_frame_t *frame, void *ctx);
typedef void (*remote_input_receiver_data_cb_t)(const remote_input_data_frame_t *frame, void *ctx);
typedef void (*remote_input_receiver_error_cb_t)(remote_input_error_t error, void *ctx);
typedef void (*remote_input_receiver_disconnect_cb_t)(void *ctx);

typedef struct {
    remote_input_receiver_control_cb_t on_control;
    remote_input_receiver_data_cb_t on_data;
    remote_input_receiver_error_cb_t on_error;
    remote_input_receiver_disconnect_cb_t on_disconnect;
    remote_input_receiver_connect_cb_t on_connect;
    void *ctx;
} remote_input_receiver_callbacks_t;

typedef struct {
    const char *name;
    esp_err_t (*init)(const remote_input_receiver_callbacks_t *callbacks);
    void (*notify_status)(void);
} remote_input_receiver_t;
