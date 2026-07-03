#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "input_config.h"
#include "input_writer.h"

esp_err_t input_hid_init(void);
bool input_hid_ready(void);
input_error_t input_hid_write_text(uint16_t task_id,
                                                 const uint8_t *bytes,
                                                 size_t len,
                                                 const input_config_t *config,
                                                 void *ctx);

extern const input_writer_t input_hid_writer;
