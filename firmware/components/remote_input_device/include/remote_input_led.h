#pragma once

#include <stdbool.h>

#include "esp_err.h"

typedef enum {
    REMOTE_INPUT_LED_WAITING_CONNECTION = 0,
    REMOTE_INPUT_LED_CONNECTED_IDLE = 1,
    REMOTE_INPUT_LED_TYPING = 2,
} remote_input_led_mode_t;

esp_err_t remote_input_led_init(void);
void remote_input_led_set_connected(bool connected);
void remote_input_led_set_typing(bool typing);
