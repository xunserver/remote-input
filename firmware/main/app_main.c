#include "input_service.h"

#include "esp_err.h"
#include "esp_log.h"

static const char *TAG = "input";

void app_main(void)
{
    ESP_LOGI(TAG, "Input firmware booting");
    ESP_ERROR_CHECK(input_service_init());
    ESP_LOGI(TAG, "Input ready");
}
