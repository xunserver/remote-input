#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "remote_input_protocol.h"
#include "remote_input_status.h"
#include "remote_input_task.h"

typedef bool (*remote_input_engine_busy_cb_t)(void *ctx);
typedef remote_input_error_t (*remote_input_engine_submit_text_cb_t)(uint16_t task_id,
                                                                     const uint8_t *bytes,
                                                                     size_t len,
                                                                     void *ctx);
typedef void (*remote_input_engine_status_cb_t)(remote_input_state_t state,
                                                uint16_t task_id,
                                                remote_input_error_t error,
                                                uint32_t received,
                                                uint32_t total,
                                                void *ctx);

typedef struct {
    remote_input_engine_busy_cb_t output_busy;
    remote_input_engine_submit_text_cb_t submit_text;
    remote_input_engine_status_cb_t on_status;
    void *ctx;
} remote_input_engine_callbacks_t;

typedef struct {
    remote_input_task_buffer_t task;
    remote_input_engine_callbacks_t callbacks;
} remote_input_engine_t;

void remote_input_engine_init(remote_input_engine_t *engine,
                              const remote_input_engine_callbacks_t *callbacks);
void remote_input_engine_handle_control(remote_input_engine_t *engine,
                                        const remote_input_control_frame_t *frame);
void remote_input_engine_handle_data(remote_input_engine_t *engine,
                                     const remote_input_data_frame_t *frame);
void remote_input_engine_handle_receiver_error(remote_input_engine_t *engine,
                                               remote_input_error_t error);
void remote_input_engine_reset_receive(remote_input_engine_t *engine);
