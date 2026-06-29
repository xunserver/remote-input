#include "ai_input_status.h"

#include "ai_input_protocol.h"

static ai_input_status_t g_status;

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

void ai_input_status_init(void)
{
    g_status.state = AI_INPUT_STATE_IDLE;
    g_status.last_task_id = 0;
    g_status.last_error = AI_INPUT_ERR_OK;
    g_status.received_bytes = 0;
    g_status.total_bytes = 0;
}

void ai_input_status_set(ai_input_state_t state, uint16_t task_id, ai_input_error_t error, uint32_t received, uint32_t total)
{
    g_status.state = state;
    g_status.last_task_id = task_id;
    g_status.last_error = error;
    g_status.received_bytes = received;
    g_status.total_bytes = total;
}

ai_input_status_t ai_input_status_get(void)
{
    return g_status;
}

void ai_input_status_encode(uint8_t out[14])
{
    if (out == NULL) {
        return;
    }

    out[0] = AI_INPUT_PROTOCOL_VERSION;
    out[1] = (uint8_t)g_status.state;
    write_le16(&out[2], g_status.last_task_id);
    write_le16(&out[4], (uint16_t)g_status.last_error);
    write_le32(&out[6], g_status.received_bytes);
    write_le32(&out[10], g_status.total_bytes);
}
