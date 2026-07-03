#pragma once

#include "input_receiver.h"

extern const input_receiver_t input_ble_receiver;

esp_err_t input_ble_init(const input_receiver_callbacks_t *callbacks);
void input_ble_notify_status(void);
