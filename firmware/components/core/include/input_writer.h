#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "input_protocol.h"
#include "input_status.h"

typedef struct {
    const char *name;
    esp_err_t (*init)(void *ctx);
    bool (*ready)(void *ctx);
    input_error_t (*write_text)(uint16_t task_id,
                                       const uint8_t *bytes,
                                       size_t len,
                                       const input_config_t *config,
                                       void *ctx);
    void *ctx;
} input_writer_t;
