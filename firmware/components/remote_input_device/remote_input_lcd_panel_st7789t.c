/*
 * SPDX-FileCopyrightText: 2021-2022 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include "remote_input_lcd_panel_st7789t.h"

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_lcd_panel_commands.h"
#include "esp_lcd_panel_interface.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include <assert.h>
#include <stdlib.h>
#include <sys/cdefs.h>

#if CONFIG_LCD_ENABLE_DEBUG_LOG
#define LOG_LOCAL_LEVEL ESP_LOG_DEBUG
#endif

static const char *TAG = "remote_input_st7789t";

typedef struct {
    esp_lcd_panel_t base;
    esp_lcd_panel_io_handle_t io;
    int reset_gpio_num;
    bool reset_level;
    int x_gap;
    int y_gap;
    uint8_t fb_bits_per_pixel;
    uint8_t madctl_val;
    uint8_t colmod_val;
} st7789t_panel_t;

static esp_err_t panel_st7789t_del(esp_lcd_panel_t *panel);
static esp_err_t panel_st7789t_reset(esp_lcd_panel_t *panel);
static esp_err_t panel_st7789t_init(esp_lcd_panel_t *panel);
static esp_err_t panel_st7789t_draw_bitmap(esp_lcd_panel_t *panel,
                                           int x_start,
                                           int y_start,
                                           int x_end,
                                           int y_end,
                                           const void *color_data);
static esp_err_t panel_st7789t_invert_color(esp_lcd_panel_t *panel, bool invert_color_data);
static esp_err_t panel_st7789t_mirror(esp_lcd_panel_t *panel, bool mirror_x, bool mirror_y);
static esp_err_t panel_st7789t_swap_xy(esp_lcd_panel_t *panel, bool swap_axes);
static esp_err_t panel_st7789t_set_gap(esp_lcd_panel_t *panel, int x_gap, int y_gap);
static esp_err_t panel_st7789t_disp_on_off(esp_lcd_panel_t *panel, bool on_off);

esp_err_t remote_input_lcd_new_panel_st7789t(
    const esp_lcd_panel_io_handle_t io,
    const remote_input_lcd_panel_st7789t_config_t *panel_dev_config,
    esp_lcd_panel_handle_t *ret_panel)
{
#if CONFIG_LCD_ENABLE_DEBUG_LOG
    esp_log_level_set(TAG, ESP_LOG_DEBUG);
#endif

    esp_err_t ret = ESP_OK;
    st7789t_panel_t *st7789t = NULL;
    ESP_GOTO_ON_FALSE(io && panel_dev_config && ret_panel, ESP_ERR_INVALID_ARG, err, TAG, "invalid argument");

    st7789t = calloc(1, sizeof(st7789t_panel_t));
    ESP_GOTO_ON_FALSE(st7789t != NULL, ESP_ERR_NO_MEM, err, TAG, "no mem for st7789t panel");

    if (panel_dev_config->reset_gpio_num >= 0) {
        gpio_config_t io_conf = {
            .mode = GPIO_MODE_OUTPUT,
            .pin_bit_mask = 1ULL << panel_dev_config->reset_gpio_num,
        };
        ESP_GOTO_ON_ERROR(gpio_config(&io_conf), err, TAG, "configure reset GPIO failed");
    }

    switch (panel_dev_config->rgb_ele_order) {
    case LCD_RGB_ELEMENT_ORDER_RGB:
        st7789t->madctl_val = 0;
        break;
    case LCD_RGB_ELEMENT_ORDER_BGR:
        st7789t->madctl_val = LCD_CMD_BGR_BIT;
        break;
    default:
        ESP_GOTO_ON_FALSE(false, ESP_ERR_NOT_SUPPORTED, err, TAG, "unsupported color order");
    }

    switch (panel_dev_config->bits_per_pixel) {
    case 16:
        st7789t->colmod_val = 0x55;
        st7789t->fb_bits_per_pixel = 16;
        break;
    case 18:
        st7789t->colmod_val = 0x66;
        st7789t->fb_bits_per_pixel = 24;
        break;
    default:
        ESP_GOTO_ON_FALSE(false, ESP_ERR_NOT_SUPPORTED, err, TAG, "unsupported pixel width");
    }

    st7789t->io = io;
    st7789t->reset_gpio_num = panel_dev_config->reset_gpio_num;
    st7789t->reset_level = panel_dev_config->flags.reset_active_high;
    st7789t->base.del = panel_st7789t_del;
    st7789t->base.reset = panel_st7789t_reset;
    st7789t->base.init = panel_st7789t_init;
    st7789t->base.draw_bitmap = panel_st7789t_draw_bitmap;
    st7789t->base.invert_color = panel_st7789t_invert_color;
    st7789t->base.set_gap = panel_st7789t_set_gap;
    st7789t->base.mirror = panel_st7789t_mirror;
    st7789t->base.swap_xy = panel_st7789t_swap_xy;
    st7789t->base.disp_on_off = panel_st7789t_disp_on_off;

    *ret_panel = &st7789t->base;
    return ESP_OK;

err:
    if (st7789t != NULL) {
        if (panel_dev_config != NULL && panel_dev_config->reset_gpio_num >= 0) {
            gpio_reset_pin(panel_dev_config->reset_gpio_num);
        }
        free(st7789t);
    }
    return ret;
}

static esp_err_t panel_st7789t_del(esp_lcd_panel_t *panel)
{
    st7789t_panel_t *st7789t = __containerof(panel, st7789t_panel_t, base);

    if (st7789t->reset_gpio_num >= 0) {
        gpio_reset_pin(st7789t->reset_gpio_num);
    }
    free(st7789t);
    return ESP_OK;
}

static esp_err_t panel_st7789t_reset(esp_lcd_panel_t *panel)
{
    st7789t_panel_t *st7789t = __containerof(panel, st7789t_panel_t, base);
    esp_lcd_panel_io_handle_t io = st7789t->io;

    if (st7789t->reset_gpio_num >= 0) {
        gpio_set_level(st7789t->reset_gpio_num, st7789t->reset_level);
        vTaskDelay(pdMS_TO_TICKS(10));
        gpio_set_level(st7789t->reset_gpio_num, !st7789t->reset_level);
        vTaskDelay(pdMS_TO_TICKS(10));
    } else {
        ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_SWRESET, NULL, 0), TAG, "software reset failed");
        vTaskDelay(pdMS_TO_TICKS(20));
    }

    return ESP_OK;
}

static esp_err_t panel_st7789t_init(esp_lcd_panel_t *panel)
{
    st7789t_panel_t *st7789t = __containerof(panel, st7789t_panel_t, base);
    esp_lcd_panel_io_handle_t io = st7789t->io;

    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_SLPOUT, NULL, 0), TAG, "sleep out failed");
    vTaskDelay(pdMS_TO_TICKS(100));

    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_MADCTL, (uint8_t[]){0x00}, 1), TAG, "madctl failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_COLMOD, (uint8_t[]){st7789t->colmod_val}, 1), TAG,
                        "colmod failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xB0, (uint8_t[]){0x00, 0xE8}, 2), TAG, "ram control failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xB2, (uint8_t[]){0x0c, 0x0c, 0x00, 0x33, 0x33}, 5), TAG,
                        "porch setting failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xB7, (uint8_t[]){0x75}, 1), TAG, "gate control failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xBB, (uint8_t[]){0x1A}, 1), TAG, "vcom setting failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xC0, (uint8_t[]){0x80}, 1), TAG, "lcm control failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xC2, (uint8_t[]){0x01, 0xff}, 2), TAG, "vdv/vrh failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xC3, (uint8_t[]){0x13}, 1), TAG, "vrh failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xC4, (uint8_t[]){0x20}, 1), TAG, "vdv failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xC6, (uint8_t[]){0x0F}, 1), TAG, "frame rate failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xD0, (uint8_t[]){0xA4, 0xA1}, 2), TAG, "power control failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(
                            io, 0xE0,
                            (uint8_t[]){0xD0, 0x0D, 0x14, 0x0D, 0x0D, 0x09, 0x38, 0x44, 0x4E, 0x3A, 0x17, 0x18,
                                        0x2F, 0x30},
                            14),
                        TAG, "positive gamma failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(
                            io, 0xE1,
                            (uint8_t[]){0xD0, 0x09, 0x0F, 0x08, 0x07, 0x14, 0x37, 0x44, 0x4D, 0x38, 0x15, 0x16,
                                        0x2C, 0x2E},
                            14),
                        TAG, "negative gamma failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_INVON, NULL, 0), TAG, "invert on failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_DISPON, NULL, 0), TAG, "display on failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_RAMWR, NULL, 0), TAG, "ram write failed");

    return ESP_OK;
}

static esp_err_t panel_st7789t_draw_bitmap(esp_lcd_panel_t *panel,
                                           int x_start,
                                           int y_start,
                                           int x_end,
                                           int y_end,
                                           const void *color_data)
{
    st7789t_panel_t *st7789t = __containerof(panel, st7789t_panel_t, base);
    esp_lcd_panel_io_handle_t io = st7789t->io;
    assert((x_start < x_end) && (y_start < y_end));

    x_start += st7789t->x_gap;
    x_end += st7789t->x_gap;
    y_start += st7789t->y_gap;
    y_end += st7789t->y_gap;

    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_CASET,
                                                  (uint8_t[]){
                                                      (x_start >> 8) & 0xFF,
                                                      x_start & 0xFF,
                                                      ((x_end - 1) >> 8) & 0xFF,
                                                      (x_end - 1) & 0xFF,
                                                  },
                                                  4),
                        TAG, "set column failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_RASET,
                                                  (uint8_t[]){
                                                      (y_start >> 8) & 0xFF,
                                                      y_start & 0xFF,
                                                      ((y_end - 1) >> 8) & 0xFF,
                                                      (y_end - 1) & 0xFF,
                                                  },
                                                  4),
                        TAG, "set row failed");

    size_t len = (x_end - x_start) * (y_end - y_start) * st7789t->fb_bits_per_pixel / 8;
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_color(io, LCD_CMD_RAMWR, color_data, len), TAG, "send color failed");
    return ESP_OK;
}

static esp_err_t panel_st7789t_invert_color(esp_lcd_panel_t *panel, bool invert_color_data)
{
    st7789t_panel_t *st7789t = __containerof(panel, st7789t_panel_t, base);
    return esp_lcd_panel_io_tx_param(st7789t->io, invert_color_data ? LCD_CMD_INVON : LCD_CMD_INVOFF, NULL, 0);
}

static esp_err_t panel_st7789t_mirror(esp_lcd_panel_t *panel, bool mirror_x, bool mirror_y)
{
    st7789t_panel_t *st7789t = __containerof(panel, st7789t_panel_t, base);

    if (mirror_x) {
        st7789t->madctl_val |= LCD_CMD_MX_BIT;
    } else {
        st7789t->madctl_val &= ~LCD_CMD_MX_BIT;
    }
    if (mirror_y) {
        st7789t->madctl_val |= LCD_CMD_MY_BIT;
    } else {
        st7789t->madctl_val &= ~LCD_CMD_MY_BIT;
    }

    return esp_lcd_panel_io_tx_param(st7789t->io, LCD_CMD_MADCTL, (uint8_t[]){st7789t->madctl_val}, 1);
}

static esp_err_t panel_st7789t_swap_xy(esp_lcd_panel_t *panel, bool swap_axes)
{
    st7789t_panel_t *st7789t = __containerof(panel, st7789t_panel_t, base);

    if (swap_axes) {
        st7789t->madctl_val |= LCD_CMD_MV_BIT;
    } else {
        st7789t->madctl_val &= ~LCD_CMD_MV_BIT;
    }

    return esp_lcd_panel_io_tx_param(st7789t->io, LCD_CMD_MADCTL, (uint8_t[]){st7789t->madctl_val}, 1);
}

static esp_err_t panel_st7789t_set_gap(esp_lcd_panel_t *panel, int x_gap, int y_gap)
{
    st7789t_panel_t *st7789t = __containerof(panel, st7789t_panel_t, base);

    st7789t->x_gap = x_gap;
    st7789t->y_gap = y_gap;
    return ESP_OK;
}

static esp_err_t panel_st7789t_disp_on_off(esp_lcd_panel_t *panel, bool on_off)
{
    st7789t_panel_t *st7789t = __containerof(panel, st7789t_panel_t, base);
    return esp_lcd_panel_io_tx_param(st7789t->io, on_off ? LCD_CMD_DISPON : LCD_CMD_DISPOFF, NULL, 0);
}
