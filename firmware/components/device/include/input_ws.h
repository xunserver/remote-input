#pragma once

#include "input_receiver.h"

#include "esp_err.h"

extern const input_receiver_t input_ws_receiver;

esp_err_t input_ws_init(const input_receiver_callbacks_t *callbacks);
void input_ws_notify_status(void);
