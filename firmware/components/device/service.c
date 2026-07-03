#include "input_service.h"

#include <limits.h>

#include "input_ble.h"
#include "input_config.h"
#include "input_display.h"
#include "input_engine.h"
#include "input_firmware_version.h"
#include "input_hid.h"
#include "input_lcd_port.h"
#include "input_led.h"
#include "input_receiver.h"
#include "input_status.h"
#include "input_writer_runner.h"
#include "input_ws.h"

#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "sdkconfig.h"

static const char *TAG = "input_service";
static input_engine_t s_engine;

#define INPUT_MAX_RECEIVERS 2

typedef struct {
    const input_receiver_t *receiver;
    bool initialized;
} receiver_slot_t;

static receiver_slot_t s_receivers[INPUT_MAX_RECEIVERS] = {
    { .receiver = &input_ble_receiver, .initialized = false },
#if CONFIG_INPUT_WS_ENABLED
    { .receiver = &input_ws_receiver, .initialized = false },
#else
    { .receiver = NULL, .initialized = false },
#endif
};

static int s_connected_clients;
static portMUX_TYPE s_connected_clients_lock = portMUX_INITIALIZER_UNLOCKED;

static void update_status(input_state_t state,
                          uint16_t task_id,
                          input_error_t error,
                          uint32_t received,
                          uint32_t total)
{
    input_status_set(state, task_id, error, received, total);
    input_display_set_input_state(state);
    for (size_t i = 0; i < INPUT_MAX_RECEIVERS; i += 1) {
        if (s_receivers[i].initialized &&
            s_receivers[i].receiver != NULL &&
            s_receivers[i].receiver->notify_status != NULL) {
            s_receivers[i].receiver->notify_status();
        }
    }
}

static bool writer_busy_cb(void *ctx)
{
    (void)ctx;

    return input_writer_runner_busy();
}

static input_error_t capture_config_cb(input_config_t *config, void *ctx)
{
    (void)ctx;

    if (config == NULL) {
        return INPUT_ERR_INVALID_COMMAND;
    }

    *config = input_config_get();
    return INPUT_ERR_OK;
}

static input_error_t submit_text_cb(uint16_t task_id,
                                           const uint8_t *bytes,
                                           size_t len,
                                           input_config_t config,
                                           void *ctx)
{
    (void)ctx;

    return input_writer_runner_submit(task_id, bytes, len, config);
}

static input_error_t apply_config_cb(const input_config_frame_t *frame, void *ctx)
{
    (void)ctx;

    return input_config_update(frame);
}

static void status_cb(input_state_t state,
                      uint16_t task_id,
                      input_error_t error,
                      uint32_t received,
                      uint32_t total,
                      void *ctx)
{
    (void)ctx;

    update_status(state, task_id, error, received, total);
}

static void typing_cb(bool typing, void *ctx)
{
    (void)ctx;

    input_led_set_typing(typing);
}

static void on_control(const input_control_frame_t *frame, void *ctx)
{
    (void)ctx;

    input_engine_handle_control(&s_engine, frame);
}

static void on_data(const input_data_frame_t *frame, void *ctx)
{
    (void)ctx;

    input_engine_handle_data(&s_engine, frame);
}

static void on_config(const input_config_frame_t *frame, void *ctx)
{
    (void)ctx;

    input_engine_handle_config(&s_engine, frame);
}

static void on_receiver_error(input_error_t error, void *ctx)
{
    (void)ctx;

    input_engine_handle_receiver_error(&s_engine, error);
}

static void set_client_connected(bool connected)
{
    input_led_set_connected(connected);
    input_display_set_client_connected(connected);
}

static void on_connect(void *ctx)
{
    (void)ctx;

    bool connected;

    portENTER_CRITICAL(&s_connected_clients_lock);
    if (s_connected_clients < INT_MAX) {
        s_connected_clients += 1;
    }
    connected = s_connected_clients > 0;
    portEXIT_CRITICAL(&s_connected_clients_lock);

    set_client_connected(connected);
}

static void on_disconnect(void *ctx)
{
    (void)ctx;

    bool connected;

    portENTER_CRITICAL(&s_connected_clients_lock);
    if (s_connected_clients > 0) {
        s_connected_clients -= 1;
    }
    connected = s_connected_clients > 0;
    portEXIT_CRITICAL(&s_connected_clients_lock);

    set_client_connected(connected);

    if (!connected && !input_writer_runner_busy()) {
        update_status(INPUT_STATE_IDLE, 0, INPUT_ERR_OK, 0, 0);
        input_engine_reset_receive(&s_engine);
    }
}

esp_err_t input_service_init(void)
{
    input_status_init();
    input_config_init();

    esp_err_t led_err = input_led_init();
    if (led_err != ESP_OK) {
        ESP_LOGE(TAG, "led init failed: %s", esp_err_to_name(led_err));
    }

#if CONFIG_INPUT_DISPLAY_ENABLED
    esp_err_t lcd_err = input_lcd_port_init();
    if (lcd_err != ESP_OK) {
        ESP_LOGE(TAG, "lcd init failed: %s", esp_err_to_name(lcd_err));
    } else {
        esp_err_t display_err = input_display_init(input_firmware_version_get());
        if (display_err != ESP_OK) {
            ESP_LOGE(TAG, "display init failed: %s", esp_err_to_name(display_err));
        } else {
            esp_err_t lcd_start_err = input_lcd_port_start();
            if (lcd_start_err != ESP_OK) {
                ESP_LOGE(TAG, "lcd task start failed: %s", esp_err_to_name(lcd_start_err));
            }
        }
    }
#else
    ESP_LOGI(TAG, "display disabled");
#endif

    const input_writer_runner_callbacks_t writer_callbacks = {
        .on_status = status_cb,
        .on_typing = typing_cb,
        .ctx = NULL,
    };
    esp_err_t err = input_writer_runner_init(&input_hid_writer, &writer_callbacks);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "writer init failed: %s", esp_err_to_name(err));
        return err;
    }

    const input_engine_callbacks_t engine_callbacks = {
        .output_busy = writer_busy_cb,
        .capture_config = capture_config_cb,
        .submit_text = submit_text_cb,
        .apply_config = apply_config_cb,
        .on_status = status_cb,
        .ctx = NULL,
    };
    input_engine_init(&s_engine, &engine_callbacks);

    const input_receiver_callbacks_t callbacks = {
        .on_connect = on_connect,
        .on_control = on_control,
        .on_config = on_config,
        .on_data = on_data,
        .on_error = on_receiver_error,
        .on_disconnect = on_disconnect,
        .ctx = NULL,
    };

    size_t initialized_receivers = 0;
    for (size_t i = 0; i < INPUT_MAX_RECEIVERS; i += 1) {
        if (s_receivers[i].receiver == NULL || s_receivers[i].receiver->init == NULL) {
            continue;
        }
        err = s_receivers[i].receiver->init(&callbacks);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "%s receiver init failed: %s",
                     s_receivers[i].receiver->name,
                     esp_err_to_name(err));
            continue;
        }
        s_receivers[i].initialized = true;
        initialized_receivers += 1;
    }

    if (initialized_receivers == 0) {
        ESP_LOGE(TAG, "no input receiver initialized");
        return ESP_FAIL;
    }

    return ESP_OK;
}
