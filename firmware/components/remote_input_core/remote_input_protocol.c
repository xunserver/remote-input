#include "remote_input_protocol.h"

static uint16_t read_le16(const uint8_t *p)
{
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t read_le32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

bool remote_input_parse_control_frame(const uint8_t *data, size_t len, remote_input_control_frame_t *out)
{
    if (data == NULL || out == NULL || len != REMOTE_INPUT_CONTROL_FRAME_LEN) {
        return false;
    }

    const uint8_t type = data[1];
    const uint32_t total_bytes = read_le32(&data[4]);
    const uint16_t total_chunks = read_le16(&data[8]);

    if (data[0] != REMOTE_INPUT_PROTOCOL_VERSION) {
        return false;
    }
    if (type != REMOTE_INPUT_CONTROL_START && type != REMOTE_INPUT_CONTROL_COMMIT) {
        return false;
    }
    if (total_bytes > REMOTE_INPUT_MAX_TEXT_BYTES) {
        return false;
    }
    if (total_chunks == 0) {
        return false;
    }
    if (data[10] != 0 || data[11] != 0) {
        return false;
    }

    out->type = type;
    out->task_id = read_le16(&data[2]);
    out->total_bytes = total_bytes;
    out->total_chunks = total_chunks;
    return true;
}

bool remote_input_parse_data_frame(const uint8_t *data, size_t len, remote_input_data_frame_t *out)
{
    if (data == NULL || out == NULL || len < REMOTE_INPUT_DATA_FRAME_HEADER_LEN ||
        len > REMOTE_INPUT_DATA_FRAME_HEADER_LEN + REMOTE_INPUT_DATA_PAYLOAD_BYTES) {
        return false;
    }

    const uint16_t total_chunks = read_le16(&data[6]);
    const size_t payload_len = len - REMOTE_INPUT_DATA_FRAME_HEADER_LEN;

    if (data[0] != REMOTE_INPUT_PROTOCOL_VERSION) {
        return false;
    }
    if (data[1] != REMOTE_INPUT_DATA_FRAME) {
        return false;
    }
    if (total_chunks == 0) {
        return false;
    }
    if (payload_len == 0 && total_chunks != 1) {
        return false;
    }

    out->task_id = read_le16(&data[2]);
    out->chunk_index = read_le16(&data[4]);
    out->total_chunks = total_chunks;
    out->payload = data + REMOTE_INPUT_DATA_FRAME_HEADER_LEN;
    out->payload_len = payload_len;
    return true;
}
