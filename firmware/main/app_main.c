#include "remote_input_service.h"

#include "esp_err.h"
#include "esp_log.h"

static const char *TAG = "remote_input";

void app_main(void)
{
    ESP_LOGI(TAG, "Remote Input firmware booting");
    ESP_ERROR_CHECK(remote_input_service_init());
    ESP_LOGI(TAG, "Remote Input ready");
}
