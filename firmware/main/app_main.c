#include "ai_input_service.h"

#include "esp_err.h"
#include "esp_log.h"

static const char *TAG = "ai_input";

void app_main(void)
{
    ESP_LOGI(TAG, "AI Input firmware booting");
    ESP_ERROR_CHECK(ai_input_service_init());
    ESP_LOGI(TAG, "AI Input ready");
}
