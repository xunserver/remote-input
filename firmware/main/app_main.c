#include "ai_input_hid.h"
#include "ai_input_utf8.h"

#include "esp_err.h"
#include "esp_log.h"

static const char *TAG = "ai_input";

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

    const uint8_t sample[] = { 'H', 'i', ' ', 0xE4, 0xB8, 0xAD };
    int count = 0;
    bool ok = ai_input_utf8_decode_each(sample, sizeof(sample), count_codepoint, &count);
    ESP_LOGI(TAG, "UTF-8 self check ok=%d count=%d", ok, count);
}
