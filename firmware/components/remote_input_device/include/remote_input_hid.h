#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "remote_input_config.h"
#include "remote_input_writer.h"

esp_err_t remote_input_hid_init(void);
bool remote_input_hid_ready(void);
remote_input_error_t remote_input_hid_write_text(uint16_t task_id,
                                                 const uint8_t *bytes,
                                                 size_t len,
                                                 const remote_input_config_t *config,
                                                 void *ctx);

extern const remote_input_writer_t remote_input_hid_writer;
