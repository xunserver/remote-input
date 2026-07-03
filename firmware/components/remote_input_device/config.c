#include "remote_input_config.h"

#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static remote_input_config_t s_config;
static portMUX_TYPE s_config_lock = portMUX_INITIALIZER_UNLOCKED;

remote_input_config_t remote_input_config_default(void)
{
    return (remote_input_config_t) {
        .key_delay_ms = REMOTE_INPUT_KEY_DELAY_DEFAULT_MS,
    };
}

void remote_input_config_init(void)
{
    portENTER_CRITICAL(&s_config_lock);
    s_config = remote_input_config_default();
    portEXIT_CRITICAL(&s_config_lock);
}

remote_input_config_t remote_input_config_get(void)
{
    remote_input_config_t config;

    portENTER_CRITICAL(&s_config_lock);
    config = s_config;
    portEXIT_CRITICAL(&s_config_lock);

    return config;
}

remote_input_error_t remote_input_config_update(const remote_input_config_frame_t *frame)
{
    if (frame == NULL ||
        frame->key_delay_ms < REMOTE_INPUT_KEY_DELAY_MIN_MS ||
        frame->key_delay_ms > REMOTE_INPUT_KEY_DELAY_MAX_MS) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }

    portENTER_CRITICAL(&s_config_lock);
    s_config.key_delay_ms = frame->key_delay_ms;
    portEXIT_CRITICAL(&s_config_lock);

    return REMOTE_INPUT_ERR_OK;
}
