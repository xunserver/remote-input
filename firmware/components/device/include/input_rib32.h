#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define INPUT_RIB32_VERSION 1
#define INPUT_RIB32_CHUNK_BYTES 32

typedef esp_err_t (*input_rib32_line_cb_t)(const char *line, void *ctx);

esp_err_t input_rib32_emit(uint16_t task_id,
                                  const uint8_t *bytes,
                                  size_t len,
                                  input_rib32_line_cb_t cb,
                                  void *ctx);
