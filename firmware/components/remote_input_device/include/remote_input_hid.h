#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define REMOTE_INPUT_HID_DELAY_MS 20

esp_err_t remote_input_hid_init(void);
bool remote_input_hid_ready(void);
esp_err_t remote_input_hid_type_codepoint(uint32_t codepoint);
