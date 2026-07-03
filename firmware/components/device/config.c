#include "input_config.h"

#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static input_config_t s_config;
static portMUX_TYPE s_config_lock = portMUX_INITIALIZER_UNLOCKED;

input_config_t input_config_default(void)
{
    return (input_config_t) {
        .key_delay_ms = INPUT_KEY_DELAY_DEFAULT_MS,
    };
}

void input_config_init(void)
{
    portENTER_CRITICAL(&s_config_lock);
    s_config = input_config_default();
    portEXIT_CRITICAL(&s_config_lock);
}

input_config_t input_config_get(void)
{
    input_config_t config;

    portENTER_CRITICAL(&s_config_lock);
    config = s_config;
    portEXIT_CRITICAL(&s_config_lock);

    return config;
}

input_error_t input_config_update(const input_config_frame_t *frame)
{
    if (frame == NULL ||
        frame->key_delay_ms < INPUT_KEY_DELAY_MIN_MS ||
        frame->key_delay_ms > INPUT_KEY_DELAY_MAX_MS) {
        return INPUT_ERR_INVALID_COMMAND;
    }

    portENTER_CRITICAL(&s_config_lock);
    s_config.key_delay_ms = frame->key_delay_ms;
    portEXIT_CRITICAL(&s_config_lock);

    return INPUT_ERR_OK;
}
