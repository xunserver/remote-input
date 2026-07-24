#include "relay_frame.h"

#include <stddef.h>

uint16_t relay_crc16_ccitt(const uint8_t *data, uint16_t length) {
    uint16_t crc = 0xffff;
    for (uint16_t i = 0; i < length; ++i) {
        crc ^= (uint16_t)data[i] << 8;
        for (uint8_t bit = 0; bit < 8; ++bit) {
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

bool relay_frame_validate(
    const uint8_t *data,
    uint16_t length,
    bool allow_padding,
    uint16_t *frame_length_out
) {
    if (data == NULL || length < RELAY_HEADER_BYTES || length > RELAY_REPORT_BYTES) return false;
    if (data[0] != RELAY_MAGIC_LOW || data[1] != RELAY_MAGIC_HIGH || data[2] != RELAY_VERSION || data[3] != 0) return false;

    uint32_t transfer_id = (uint32_t)data[4] | ((uint32_t)data[5] << 8) |
        ((uint32_t)data[6] << 16) | ((uint32_t)data[7] << 24);
    uint16_t chunk_index = (uint16_t)data[8] | ((uint16_t)data[9] << 8);
    uint16_t chunk_count = (uint16_t)data[10] | ((uint16_t)data[11] << 8);
    uint16_t payload_length = (uint16_t)data[12] | ((uint16_t)data[13] << 8);
    uint16_t expected_crc = (uint16_t)data[14] | ((uint16_t)data[15] << 8);
    uint32_t frame_length = RELAY_HEADER_BYTES + (uint32_t)payload_length;

    if (transfer_id == 0 || chunk_count == 0 || chunk_index >= chunk_count || frame_length > length ||
        (!allow_padding && frame_length != length) ||
        relay_crc16_ccitt(data + RELAY_HEADER_BYTES, payload_length) != expected_crc) return false;
    for (uint16_t i = (uint16_t)frame_length; i < length; ++i) {
        if (data[i] != 0) return false;
    }
    if (frame_length_out != NULL) *frame_length_out = (uint16_t)frame_length;
    return true;
}
