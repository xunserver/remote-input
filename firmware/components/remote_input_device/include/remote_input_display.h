#pragma once

#include "remote_input_status.h"

#include "esp_err.h"

#include <stdbool.h>

esp_err_t remote_input_display_init(const char *version);
void remote_input_display_set_client_connected(bool connected);
void remote_input_display_set_ble_connected(bool connected);
void remote_input_display_set_input_state(remote_input_state_t state);
