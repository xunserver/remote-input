#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define REMOTE_INPUT_RIB32_VERSION 1
#define REMOTE_INPUT_RIB32_CHUNK_BYTES 32

typedef esp_err_t (*remote_input_rib32_line_cb_t)(const char *line, void *ctx);

esp_err_t remote_input_rib32_emit(uint16_t task_id,
                                  const uint8_t *bytes,
                                  size_t len,
                                  remote_input_rib32_line_cb_t cb,
                                  void *ctx);
