#include "remote_input_led.h"

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"

#define REMOTE_INPUT_LED_GPIO 38
#define REMOTE_INPUT_LED_COUNT 1
#define REMOTE_INPUT_LED_RMT_RESOLUTION_HZ (10 * 1000 * 1000)
#define REMOTE_INPUT_LED_TASK_STACK_SIZE 2048
#define REMOTE_INPUT_LED_TASK_PRIORITY 3
#define REMOTE_INPUT_LED_BLINK_MS 150

static const char *TAG = "remote_input_led";

static led_strip_handle_t s_led_strip;
static TaskHandle_t s_led_task_handle;
static portMUX_TYPE s_led_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_connected;
static bool s_typing;
static remote_input_led_mode_t s_mode = REMOTE_INPUT_LED_WAITING_CONNECTION;
static bool s_initialized;

static void cleanup_led_strip(void)
{
    if (s_led_strip != NULL) {
        esp_err_t err = led_strip_del(s_led_strip);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "failed to delete led strip: %s", esp_err_to_name(err));
        }
        s_led_strip = NULL;
    }
}

static remote_input_led_mode_t derive_mode_locked(void)
{
    if (s_typing) {
        return REMOTE_INPUT_LED_TYPING;
    }
    if (s_connected) {
        return REMOTE_INPUT_LED_CONNECTED_IDLE;
    }
    return REMOTE_INPUT_LED_WAITING_CONNECTION;
}

static remote_input_led_mode_t get_mode(void)
{
    remote_input_led_mode_t mode;

    portENTER_CRITICAL(&s_led_lock);
    mode = s_mode;
    portEXIT_CRITICAL(&s_led_lock);

    return mode;
}

static void set_pixel(uint8_t red, uint8_t green, uint8_t blue)
{
    if (!s_initialized || s_led_strip == NULL) {
        return;
    }

    esp_err_t err = led_strip_set_pixel(s_led_strip, 0, red, green, blue);
    if (err == ESP_OK) {
        err = led_strip_refresh(s_led_strip);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "failed to update led: %s", esp_err_to_name(err));
    }
}

static void set_solid_for_mode(remote_input_led_mode_t mode)
{
    switch (mode) {
    case REMOTE_INPUT_LED_WAITING_CONNECTION:
        set_pixel(32, 0, 0);
        break;
    case REMOTE_INPUT_LED_CONNECTED_IDLE:
        set_pixel(0, 32, 0);
        break;
    case REMOTE_INPUT_LED_TYPING:
        set_pixel(0, 0, 48);
        break;
    default:
        set_pixel(0, 0, 0);
        break;
    }
}

static void notify_led_task(void)
{
    if (s_led_task_handle != NULL) {
        xTaskNotifyGive(s_led_task_handle);
    }
}

static void update_state(bool connected, bool typing, bool update_connected, bool update_typing)
{
    bool changed = false;

    portENTER_CRITICAL(&s_led_lock);
    if (update_connected && s_connected != connected) {
        s_connected = connected;
        changed = true;
    }
    if (update_typing && s_typing != typing) {
        s_typing = typing;
        changed = true;
    }
    if (changed) {
        s_mode = derive_mode_locked();
    }
    portEXIT_CRITICAL(&s_led_lock);

    if (changed) {
        notify_led_task();
    }
}

static void led_task(void *ctx)
{
    (void)ctx;

    bool blink_on = false;
    remote_input_led_mode_t applied_solid_mode = (remote_input_led_mode_t)-1;

    for (;;) {
        const remote_input_led_mode_t mode = get_mode();

        if (mode == REMOTE_INPUT_LED_TYPING) {
            blink_on = !blink_on;
            if (blink_on) {
                set_pixel(0, 0, 48);
            } else {
                set_pixel(0, 0, 0);
            }
            applied_solid_mode = (remote_input_led_mode_t)-1;
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(REMOTE_INPUT_LED_BLINK_MS));
            continue;
        }

        if (applied_solid_mode != mode) {
            set_solid_for_mode(mode);
            applied_solid_mode = mode;
        }
        blink_on = false;
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    }
}

esp_err_t remote_input_led_init(void)
{
    led_strip_config_t strip_config = {
        .strip_gpio_num = REMOTE_INPUT_LED_GPIO,
        .max_leds = REMOTE_INPUT_LED_COUNT,
    };
    led_strip_rmt_config_t rmt_config = {
        .resolution_hz = REMOTE_INPUT_LED_RMT_RESOLUTION_HZ,
    };

    ESP_RETURN_ON_ERROR(led_strip_new_rmt_device(&strip_config, &rmt_config, &s_led_strip),
                        TAG,
                        "failed to create led strip");

    esp_err_t err = led_strip_clear(s_led_strip);
    if (err != ESP_OK) {
        cleanup_led_strip();
        ESP_LOGE(TAG, "failed to clear led strip: %s", esp_err_to_name(err));
        return err;
    }

    portENTER_CRITICAL(&s_led_lock);
    s_connected = false;
    s_typing = false;
    s_mode = REMOTE_INPUT_LED_WAITING_CONNECTION;
    s_initialized = true;
    portEXIT_CRITICAL(&s_led_lock);

    BaseType_t created = xTaskCreate(led_task,
                                     "remote_input_led",
                                     REMOTE_INPUT_LED_TASK_STACK_SIZE,
                                     NULL,
                                     REMOTE_INPUT_LED_TASK_PRIORITY,
                                     &s_led_task_handle);
    if (created != pdPASS) {
        s_led_task_handle = NULL;
        portENTER_CRITICAL(&s_led_lock);
        s_initialized = false;
        portEXIT_CRITICAL(&s_led_lock);
        cleanup_led_strip();
        return ESP_ERR_NO_MEM;
    }

    notify_led_task();
    return ESP_OK;
}

void remote_input_led_set_connected(bool connected)
{
    update_state(connected, false, true, false);
}

void remote_input_led_set_typing(bool typing)
{
    update_state(false, typing, false, true);
}
