#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "input_config.h"
#include "input_status.h"
#include "input_writer.h"

typedef void (*input_writer_runner_status_cb_t)(input_state_t state,
                                                       uint16_t task_id,
                                                       input_error_t error,
                                                       uint32_t received,
                                                       uint32_t total,
                                                       void *ctx);
typedef void (*input_writer_runner_typing_cb_t)(bool typing, void *ctx);

typedef struct {
    input_writer_runner_status_cb_t on_status;
    input_writer_runner_typing_cb_t on_typing;
    void *ctx;
} input_writer_runner_callbacks_t;

esp_err_t input_writer_runner_init(const input_writer_t *writer,
                                          const input_writer_runner_callbacks_t *callbacks);
bool input_writer_runner_busy(void);
input_error_t input_writer_runner_submit(uint16_t task_id,
                                                       const uint8_t *bytes,
                                                       size_t len,
                                                       input_config_t config);
