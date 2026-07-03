#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "input_protocol.h"
#include "input_status.h"
#include "input_task.h"

typedef bool (*input_engine_busy_cb_t)(void *ctx);
typedef input_error_t (*input_engine_capture_config_cb_t)(input_config_t *config, void *ctx);
typedef input_error_t (*input_engine_submit_text_cb_t)(uint16_t task_id,
                                                                     const uint8_t *bytes,
                                                                     size_t len,
                                                                     input_config_t config,
                                                                     void *ctx);
typedef input_error_t (*input_engine_config_cb_t)(const input_config_frame_t *frame,
                                                                void *ctx);
typedef void (*input_engine_status_cb_t)(input_state_t state,
                                                uint16_t task_id,
                                                input_error_t error,
                                                uint32_t received,
                                                uint32_t total,
                                                void *ctx);

typedef struct {
    input_engine_busy_cb_t output_busy;
    input_engine_capture_config_cb_t capture_config;
    input_engine_submit_text_cb_t submit_text;
    input_engine_config_cb_t apply_config;
    input_engine_status_cb_t on_status;
    void *ctx;
} input_engine_callbacks_t;

typedef struct {
    input_task_buffer_t task;
    input_engine_callbacks_t callbacks;
} input_engine_t;

void input_engine_init(input_engine_t *engine,
                              const input_engine_callbacks_t *callbacks);
void input_engine_handle_control(input_engine_t *engine,
                                        const input_control_frame_t *frame);
void input_engine_handle_config(input_engine_t *engine,
                                       const input_config_frame_t *frame);
void input_engine_handle_data(input_engine_t *engine,
                                     const input_data_frame_t *frame);
void input_engine_handle_receiver_error(input_engine_t *engine,
                                               input_error_t error);
void input_engine_reset_receive(input_engine_t *engine);
