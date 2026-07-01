#include "remote_input_service.h"

#include "remote_input_ble.h"
#include "remote_input_display.h"
#include "remote_input_engine.h"
#include "remote_input_firmware_version.h"
#include "remote_input_hid.h"
#include "remote_input_led.h"
#include "remote_input_receiver.h"
#include "remote_input_status.h"
#include "remote_input_writer_runner.h"

#include "esp_err.h"
#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "remote_input_service";
static remote_input_engine_t s_engine;
static const remote_input_receiver_t *s_receiver = &remote_input_ble_receiver;

static void update_status(remote_input_state_t state,
                          uint16_t task_id,
                          remote_input_error_t error,
                          uint32_t received,
                          uint32_t total)
{
    remote_input_status_set(state, task_id, error, received, total);
    remote_input_display_set_input_state(state);
    if (s_receiver != NULL && s_receiver->notify_status != NULL) {
        s_receiver->notify_status();
    }
}

static bool writer_busy_cb(void *ctx)
{
    (void)ctx;

    return remote_input_writer_runner_busy();
}

static remote_input_error_t submit_text_cb(uint16_t task_id, const uint8_t *bytes, size_t len, void *ctx)
{
    (void)ctx;

    return remote_input_writer_runner_submit(task_id, bytes, len);
}

static void status_cb(remote_input_state_t state,
                      uint16_t task_id,
                      remote_input_error_t error,
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

    remote_input_led_set_typing(typing);
}

static void on_control(const remote_input_control_frame_t *frame, void *ctx)
{
    (void)ctx;

    remote_input_engine_handle_control(&s_engine, frame);
}

static void on_data(const remote_input_data_frame_t *frame, void *ctx)
{
    (void)ctx;

    remote_input_engine_handle_data(&s_engine, frame);
}

static void on_receiver_error(remote_input_error_t error, void *ctx)
{
    (void)ctx;

    remote_input_engine_handle_receiver_error(&s_engine, error);
}

static void on_connect(void *ctx)
{
    (void)ctx;

    remote_input_led_set_connected(true);
    remote_input_display_set_ble_connected(true);
}

static void on_disconnect(void *ctx)
{
    (void)ctx;

    remote_input_led_set_connected(false);
    remote_input_display_set_ble_connected(false);

    if (!remote_input_writer_runner_busy()) {
        update_status(REMOTE_INPUT_STATE_IDLE, 0, REMOTE_INPUT_ERR_OK, 0, 0);
        remote_input_engine_reset_receive(&s_engine);
    }
}

esp_err_t remote_input_service_init(void)
{
    remote_input_status_init();

    esp_err_t led_err = remote_input_led_init();
    if (led_err != ESP_OK) {
        ESP_LOGE(TAG, "led init failed: %s", esp_err_to_name(led_err));
    }

#if CONFIG_REMOTE_INPUT_DISPLAY_ENABLED
    esp_err_t display_err = remote_input_display_init(REMOTE_INPUT_FIRMWARE_VERSION);
    if (display_err != ESP_OK) {
        ESP_LOGE(TAG, "display init failed: %s", esp_err_to_name(display_err));
    }
#else
    ESP_LOGI(TAG, "display disabled");
#endif

    const remote_input_writer_runner_callbacks_t writer_callbacks = {
        .on_status = status_cb,
        .on_typing = typing_cb,
        .ctx = NULL,
    };
    esp_err_t err = remote_input_writer_runner_init(&remote_input_hid_writer, &writer_callbacks);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "writer init failed: %s", esp_err_to_name(err));
        return err;
    }

    const remote_input_engine_callbacks_t engine_callbacks = {
        .output_busy = writer_busy_cb,
        .submit_text = submit_text_cb,
        .on_status = status_cb,
        .ctx = NULL,
    };
    remote_input_engine_init(&s_engine, &engine_callbacks);

    const remote_input_receiver_callbacks_t callbacks = {
        .on_connect = on_connect,
        .on_control = on_control,
        .on_data = on_data,
        .on_error = on_receiver_error,
        .on_disconnect = on_disconnect,
        .ctx = NULL,
    };
    err = s_receiver->init(&callbacks);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ble init failed: %s", esp_err_to_name(err));
        return err;
    }

    return ESP_OK;
}
