#pragma once

#include "input_status.h"

#include "esp_err.h"

#include <stdbool.h>

esp_err_t input_display_init(const char *version);
void input_display_set_client_connected(bool connected);
void input_display_set_ble_connected(bool connected);
void input_display_set_input_state(input_state_t state);
