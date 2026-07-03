#pragma once

#include "esp_err.h"
#include "input_protocol.h"
#include "input_status.h"

typedef void (*input_receiver_connect_cb_t)(void *ctx);
typedef void (*input_receiver_control_cb_t)(const input_control_frame_t *frame, void *ctx);
typedef void (*input_receiver_config_cb_t)(const input_config_frame_t *frame, void *ctx);
typedef void (*input_receiver_data_cb_t)(const input_data_frame_t *frame, void *ctx);
typedef void (*input_receiver_error_cb_t)(input_error_t error, void *ctx);
typedef void (*input_receiver_disconnect_cb_t)(void *ctx);

typedef struct {
    input_receiver_control_cb_t on_control;
    input_receiver_config_cb_t on_config;
    input_receiver_data_cb_t on_data;
    input_receiver_error_cb_t on_error;
    input_receiver_disconnect_cb_t on_disconnect;
    input_receiver_connect_cb_t on_connect;
    void *ctx;
} input_receiver_callbacks_t;

typedef struct {
    const char *name;
    esp_err_t (*init)(const input_receiver_callbacks_t *callbacks);
    void (*notify_status)(void);
} input_receiver_t;
