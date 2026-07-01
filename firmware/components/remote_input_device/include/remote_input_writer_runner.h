#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "remote_input_status.h"
#include "remote_input_writer.h"

typedef void (*remote_input_writer_runner_status_cb_t)(remote_input_state_t state,
                                                       uint16_t task_id,
                                                       remote_input_error_t error,
                                                       uint32_t received,
                                                       uint32_t total,
                                                       void *ctx);
typedef void (*remote_input_writer_runner_typing_cb_t)(bool typing, void *ctx);

typedef struct {
    remote_input_writer_runner_status_cb_t on_status;
    remote_input_writer_runner_typing_cb_t on_typing;
    void *ctx;
} remote_input_writer_runner_callbacks_t;

esp_err_t remote_input_writer_runner_init(const remote_input_writer_t *writer,
                                          const remote_input_writer_runner_callbacks_t *callbacks);
bool remote_input_writer_runner_busy(void);
remote_input_error_t remote_input_writer_runner_submit(uint16_t task_id,
                                                       const uint8_t *bytes,
                                                       size_t len);
