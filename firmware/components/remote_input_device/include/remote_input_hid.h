#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "remote_input_writer.h"

#define REMOTE_INPUT_HID_DELAY_MS 20

esp_err_t remote_input_hid_init(void);
bool remote_input_hid_ready(void);
esp_err_t remote_input_hid_type_codepoint(uint32_t codepoint);
remote_input_error_t remote_input_hid_write_text(const uint8_t *bytes, size_t len, void *ctx);

extern const remote_input_writer_t remote_input_hid_writer;
