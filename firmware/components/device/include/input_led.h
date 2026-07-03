#pragma once

#include <stdbool.h>

#include "esp_err.h"

typedef enum {
    INPUT_LED_WAITING_CONNECTION = 0,
    INPUT_LED_CONNECTED_IDLE = 1,
    INPUT_LED_TYPING = 2,
} input_led_mode_t;

esp_err_t input_led_init(void);
void input_led_set_connected(bool connected);
void input_led_set_typing(bool typing);
