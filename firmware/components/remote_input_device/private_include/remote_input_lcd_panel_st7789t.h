/*
 * SPDX-FileCopyrightText: 2021-2022 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#pragma once

#include "esp_err.h"
#include "esp_lcd_types.h"

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int reset_gpio_num;
    lcd_rgb_element_order_t rgb_ele_order;
    unsigned int bits_per_pixel;
    struct {
        unsigned int reset_active_high: 1;
    } flags;
    void *vendor_config;
} remote_input_lcd_panel_st7789t_config_t;

esp_err_t remote_input_lcd_new_panel_st7789t(
    const esp_lcd_panel_io_handle_t io,
    const remote_input_lcd_panel_st7789t_config_t *panel_dev_config,
    esp_lcd_panel_handle_t *ret_panel);

#ifdef __cplusplus
}
#endif
