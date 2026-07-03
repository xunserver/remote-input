#pragma once

#include "remote_input_receiver.h"

extern const remote_input_receiver_t remote_input_ble_receiver;

esp_err_t remote_input_ble_init(const remote_input_receiver_callbacks_t *callbacks);
void remote_input_ble_notify_status(void);
