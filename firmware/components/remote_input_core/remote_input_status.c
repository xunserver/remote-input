#include "remote_input_status.h"

#include "remote_input_protocol.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static remote_input_status_t g_status;
static portMUX_TYPE g_status_lock = portMUX_INITIALIZER_UNLOCKED;

static void write_le16(uint8_t *p, uint16_t value)
{
    p[0] = (uint8_t)(value & 0xff);
    p[1] = (uint8_t)((value >> 8) & 0xff);
}

static void write_le32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)(value & 0xff);
    p[1] = (uint8_t)((value >> 8) & 0xff);
    p[2] = (uint8_t)((value >> 16) & 0xff);
    p[3] = (uint8_t)((value >> 24) & 0xff);
}

void remote_input_status_init(void)
{
    portENTER_CRITICAL(&g_status_lock);
    g_status.state = REMOTE_INPUT_STATE_IDLE;
    g_status.last_task_id = 0;
    g_status.last_error = REMOTE_INPUT_ERR_OK;
    g_status.received_bytes = 0;
    g_status.total_bytes = 0;
    portEXIT_CRITICAL(&g_status_lock);
}

void remote_input_status_set(remote_input_state_t state, uint16_t task_id, remote_input_error_t error, uint32_t received, uint32_t total)
{
    portENTER_CRITICAL(&g_status_lock);
    g_status.state = state;
    g_status.last_task_id = task_id;
    g_status.last_error = error;
    g_status.received_bytes = received;
    g_status.total_bytes = total;
    portEXIT_CRITICAL(&g_status_lock);
}

remote_input_status_t remote_input_status_get(void)
{
    remote_input_status_t snapshot;
    portENTER_CRITICAL(&g_status_lock);
    snapshot = g_status;
    portEXIT_CRITICAL(&g_status_lock);
    return snapshot;
}

void remote_input_status_encode(uint8_t out[14])
{
    if (out == NULL) {
        return;
    }

    const remote_input_status_t snapshot = remote_input_status_get();

    out[0] = REMOTE_INPUT_PROTOCOL_VERSION;
    out[1] = (uint8_t)snapshot.state;
    write_le16(&out[2], snapshot.last_task_id);
    write_le16(&out[4], (uint16_t)snapshot.last_error);
    write_le32(&out[6], snapshot.received_bytes);
    write_le32(&out[10], snapshot.total_bytes);
}
