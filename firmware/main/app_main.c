#include "ai_input_ble.h"
#include "ai_input_hid.h"
#include "ai_input_utf8.h"

#include "esp_err.h"
#include "esp_log.h"

static const char *TAG = "ai_input";

static void on_control(const ai_input_control_frame_t *frame)
{
    ESP_LOGI(TAG, "control type=%u task=%u", frame->type, frame->task_id);
}

static void on_data(const ai_input_data_frame_t *frame)
{
    ESP_LOGI(TAG, "data task=%u chunk=%u", frame->task_id, frame->chunk_index);
}

static bool count_codepoint(uint32_t codepoint, void *ctx)
{
    (void)codepoint;
    int *count = (int *)ctx;
    *count += 1;
    return true;
}

void app_main(void)
{
    ESP_LOGI(TAG, "AI Input firmware booting");

    ESP_ERROR_CHECK(ai_input_hid_init());
    ESP_LOGI(TAG, "HID initialized");

    const ai_input_ble_callbacks_t callbacks = {
        .on_control = on_control,
        .on_data = on_data,
    };
    ESP_ERROR_CHECK(ai_input_ble_init(&callbacks));

    const uint8_t sample[] = { 'H', 'i', ' ', 0xE4, 0xB8, 0xAD };
    int count = 0;
    bool ok = ai_input_utf8_decode_each(sample, sizeof(sample), count_codepoint, &count);
    ESP_LOGI(TAG, "UTF-8 self check ok=%d count=%d", ok, count);
}
