#include "remote_input_lcd_port.h"

#include "remote_input_lcd_panel_st7789t.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"

#include <stdbool.h>
#include <stdint.h>

#define REMOTE_INPUT_LCD_HOST SPI3_HOST
#define REMOTE_INPUT_LCD_PIXEL_CLOCK_HZ (12 * 1000 * 1000)
#define REMOTE_INPUT_LCD_H_RES 172
#define REMOTE_INPUT_LCD_V_RES 320
#define REMOTE_INPUT_LCD_CMD_BITS 8
#define REMOTE_INPUT_LCD_PARAM_BITS 8
#define REMOTE_INPUT_LCD_OFFSET_X 34
#define REMOTE_INPUT_LCD_OFFSET_Y 0

#define REMOTE_INPUT_LCD_PIN_SCLK 40
#define REMOTE_INPUT_LCD_PIN_MOSI 45
#define REMOTE_INPUT_LCD_PIN_MISO -1
#define REMOTE_INPUT_LCD_PIN_DC 41
#define REMOTE_INPUT_LCD_PIN_RST 39
#define REMOTE_INPUT_LCD_PIN_CS 42
#define REMOTE_INPUT_LCD_PIN_BK_LIGHT 48

#define REMOTE_INPUT_LCD_BK_LEDC_MODE LEDC_LOW_SPEED_MODE
#define REMOTE_INPUT_LCD_BK_LEDC_TIMER LEDC_TIMER_0
#define REMOTE_INPUT_LCD_BK_LEDC_CHANNEL LEDC_CHANNEL_0
#define REMOTE_INPUT_LCD_BK_LEDC_RES LEDC_TIMER_13_BIT
#define REMOTE_INPUT_LCD_BK_LEDC_MAX_DUTY ((1 << REMOTE_INPUT_LCD_BK_LEDC_RES) - 1)
#define REMOTE_INPUT_LCD_BK_DEFAULT_PERCENT 75

#define REMOTE_INPUT_LVGL_TICK_PERIOD_MS 2
#define REMOTE_INPUT_LVGL_HANDLER_PERIOD_MS 10
#define REMOTE_INPUT_LVGL_TASK_STACK_SIZE 4096
#define REMOTE_INPUT_LVGL_TASK_PRIORITY 2
#define REMOTE_INPUT_LVGL_BUF_PIXELS (REMOTE_INPUT_LCD_H_RES * 20)

static const char *TAG = "remote_input_lcd";

static lv_color_t s_lvgl_buf1[REMOTE_INPUT_LVGL_BUF_PIXELS];
static lv_color_t s_lvgl_buf2[REMOTE_INPUT_LVGL_BUF_PIXELS];
static lv_disp_draw_buf_t s_disp_buf;
static lv_disp_drv_t s_disp_drv;
static esp_lcd_panel_handle_t s_panel_handle;
static TaskHandle_t s_lvgl_task;
static esp_timer_handle_t s_lvgl_tick_timer;
static bool s_initialized;
static bool s_started;

static void lvgl_tick_cb(void *arg)
{
    (void)arg;
    lv_tick_inc(REMOTE_INPUT_LVGL_TICK_PERIOD_MS);
}

static bool lcd_flush_ready_cb(esp_lcd_panel_io_handle_t panel_io,
                               esp_lcd_panel_io_event_data_t *edata,
                               void *user_ctx)
{
    (void)panel_io;
    (void)edata;

    lv_disp_flush_ready((lv_disp_drv_t *)user_ctx);
    return false;
}

static void lvgl_flush_cb(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *color_map)
{
    esp_lcd_panel_handle_t panel_handle = (esp_lcd_panel_handle_t)drv->user_data;

    esp_err_t err = esp_lcd_panel_draw_bitmap(panel_handle,
                                              area->x1 + REMOTE_INPUT_LCD_OFFSET_X,
                                              area->y1 + REMOTE_INPUT_LCD_OFFSET_Y,
                                              area->x2 + REMOTE_INPUT_LCD_OFFSET_X + 1,
                                              area->y2 + REMOTE_INPUT_LCD_OFFSET_Y + 1,
                                              color_map);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "draw bitmap failed: %s", esp_err_to_name(err));
        lv_disp_flush_ready(drv);
    }
}

static void lvgl_port_update_cb(lv_disp_drv_t *drv)
{
    esp_lcd_panel_handle_t panel_handle = (esp_lcd_panel_handle_t)drv->user_data;

    switch (drv->rotated) {
    case LV_DISP_ROT_NONE:
        esp_lcd_panel_swap_xy(panel_handle, false);
        esp_lcd_panel_mirror(panel_handle, true, false);
        break;
    case LV_DISP_ROT_90:
        esp_lcd_panel_swap_xy(panel_handle, true);
        esp_lcd_panel_mirror(panel_handle, true, true);
        break;
    case LV_DISP_ROT_180:
        esp_lcd_panel_swap_xy(panel_handle, false);
        esp_lcd_panel_mirror(panel_handle, false, true);
        break;
    case LV_DISP_ROT_270:
        esp_lcd_panel_swap_xy(panel_handle, true);
        esp_lcd_panel_mirror(panel_handle, false, false);
        break;
    }
}

static void lvgl_task(void *arg)
{
    (void)arg;

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(REMOTE_INPUT_LVGL_HANDLER_PERIOD_MS));
        lv_timer_handler();
    }
}

static esp_err_t backlight_init(void)
{
    gpio_config_t bk_gpio_config = {
        .mode = GPIO_MODE_OUTPUT,
        .pin_bit_mask = 1ULL << REMOTE_INPUT_LCD_PIN_BK_LIGHT,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&bk_gpio_config), TAG, "configure backlight GPIO failed");

    ledc_timer_config_t ledc_timer = {
        .speed_mode = REMOTE_INPUT_LCD_BK_LEDC_MODE,
        .timer_num = REMOTE_INPUT_LCD_BK_LEDC_TIMER,
        .duty_resolution = REMOTE_INPUT_LCD_BK_LEDC_RES,
        .freq_hz = 5000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_RETURN_ON_ERROR(ledc_timer_config(&ledc_timer), TAG, "configure backlight timer failed");

    ledc_channel_config_t ledc_channel = {
        .gpio_num = REMOTE_INPUT_LCD_PIN_BK_LIGHT,
        .speed_mode = REMOTE_INPUT_LCD_BK_LEDC_MODE,
        .channel = REMOTE_INPUT_LCD_BK_LEDC_CHANNEL,
        .timer_sel = REMOTE_INPUT_LCD_BK_LEDC_TIMER,
        .duty = 0,
        .hpoint = 0,
    };
    ESP_RETURN_ON_ERROR(ledc_channel_config(&ledc_channel), TAG, "configure backlight channel failed");
    return ESP_OK;
}

static esp_err_t backlight_set_percent(uint8_t percent)
{
    if (percent > 100) {
        percent = 100;
    }

    uint32_t duty = 0;
    if (percent > 0) {
        duty = REMOTE_INPUT_LCD_BK_LEDC_MAX_DUTY - (81U * (100U - percent));
    }

    ESP_RETURN_ON_ERROR(ledc_set_duty(REMOTE_INPUT_LCD_BK_LEDC_MODE, REMOTE_INPUT_LCD_BK_LEDC_CHANNEL, duty), TAG,
                        "set backlight duty failed");
    ESP_RETURN_ON_ERROR(ledc_update_duty(REMOTE_INPUT_LCD_BK_LEDC_MODE, REMOTE_INPUT_LCD_BK_LEDC_CHANNEL), TAG,
                        "update backlight duty failed");
    return ESP_OK;
}

static esp_err_t lcd_panel_init(void)
{
    spi_bus_config_t buscfg = {
        .sclk_io_num = REMOTE_INPUT_LCD_PIN_SCLK,
        .mosi_io_num = REMOTE_INPUT_LCD_PIN_MOSI,
        .miso_io_num = REMOTE_INPUT_LCD_PIN_MISO,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = REMOTE_INPUT_LCD_H_RES * REMOTE_INPUT_LCD_V_RES * sizeof(uint16_t),
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(REMOTE_INPUT_LCD_HOST, &buscfg, SPI_DMA_CH_AUTO), TAG,
                        "initialize SPI bus failed");

    esp_lcd_panel_io_handle_t io_handle = NULL;
    esp_lcd_panel_io_spi_config_t io_config = {
        .dc_gpio_num = REMOTE_INPUT_LCD_PIN_DC,
        .cs_gpio_num = REMOTE_INPUT_LCD_PIN_CS,
        .pclk_hz = REMOTE_INPUT_LCD_PIXEL_CLOCK_HZ,
        .lcd_cmd_bits = REMOTE_INPUT_LCD_CMD_BITS,
        .lcd_param_bits = REMOTE_INPUT_LCD_PARAM_BITS,
        .spi_mode = 0,
        .trans_queue_depth = 10,
        .on_color_trans_done = lcd_flush_ready_cb,
        .user_ctx = &s_disp_drv,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)REMOTE_INPUT_LCD_HOST, &io_config,
                                                 &io_handle),
                        TAG, "install panel IO failed");

    remote_input_lcd_panel_st7789t_config_t panel_config = {
        .reset_gpio_num = REMOTE_INPUT_LCD_PIN_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };
    ESP_RETURN_ON_ERROR(remote_input_lcd_new_panel_st7789t(io_handle, &panel_config, &s_panel_handle), TAG,
                        "install ST7789T panel failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s_panel_handle), TAG, "reset panel failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_panel_handle), TAG, "init panel failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_mirror(s_panel_handle, true, false), TAG, "mirror panel failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s_panel_handle, true), TAG, "turn display on failed");
    return ESP_OK;
}

static esp_err_t lvgl_init(void)
{
    lv_init();

    lv_disp_draw_buf_init(&s_disp_buf, s_lvgl_buf1, s_lvgl_buf2, REMOTE_INPUT_LVGL_BUF_PIXELS);

    lv_disp_drv_init(&s_disp_drv);
    s_disp_drv.hor_res = REMOTE_INPUT_LCD_H_RES;
    s_disp_drv.ver_res = REMOTE_INPUT_LCD_V_RES;
    s_disp_drv.flush_cb = lvgl_flush_cb;
    s_disp_drv.drv_update_cb = lvgl_port_update_cb;
    s_disp_drv.draw_buf = &s_disp_buf;
    s_disp_drv.user_data = s_panel_handle;
    lv_disp_drv_register(&s_disp_drv);

    const esp_timer_create_args_t lvgl_tick_timer_args = {
        .callback = lvgl_tick_cb,
        .name = "lvgl_tick",
    };
    ESP_RETURN_ON_ERROR(esp_timer_create(&lvgl_tick_timer_args, &s_lvgl_tick_timer), TAG,
                        "create LVGL tick timer failed");
    ESP_RETURN_ON_ERROR(esp_timer_start_periodic(s_lvgl_tick_timer, REMOTE_INPUT_LVGL_TICK_PERIOD_MS * 1000), TAG,
                        "start LVGL tick timer failed");

    return ESP_OK;
}

esp_err_t remote_input_lcd_port_init(void)
{
    if (s_initialized) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "initialize ESP32-S3-LCD-1.47 display");
    ESP_RETURN_ON_ERROR(lcd_panel_init(), TAG, "LCD panel init failed");
    ESP_RETURN_ON_ERROR(backlight_init(), TAG, "backlight init failed");
    ESP_RETURN_ON_ERROR(backlight_set_percent(REMOTE_INPUT_LCD_BK_DEFAULT_PERCENT), TAG, "backlight set failed");
    ESP_RETURN_ON_ERROR(lvgl_init(), TAG, "LVGL init failed");

    s_initialized = true;
    return ESP_OK;
}

esp_err_t remote_input_lcd_port_start(void)
{
    ESP_RETURN_ON_FALSE(s_initialized, ESP_ERR_INVALID_STATE, TAG, "LCD port is not initialized");
    if (s_started) {
        return ESP_OK;
    }

    BaseType_t task_created = xTaskCreate(lvgl_task,
                                          "lvgl",
                                          REMOTE_INPUT_LVGL_TASK_STACK_SIZE,
                                          NULL,
                                          REMOTE_INPUT_LVGL_TASK_PRIORITY,
                                          &s_lvgl_task);
    ESP_RETURN_ON_FALSE(task_created == pdPASS, ESP_ERR_NO_MEM, TAG, "create LVGL task failed");

    s_started = true;
    return ESP_OK;
}
