#pragma once

#include "remote_input_receiver.h"

#include "esp_err.h"

extern const remote_input_receiver_t remote_input_ws_receiver;

esp_err_t remote_input_ws_init(const remote_input_receiver_callbacks_t *callbacks);
void remote_input_ws_notify_status(void);
