#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AI_INPUT_PROTOCOL_VERSION 1
#define AI_INPUT_MAX_TEXT_BYTES (16 * 1024)
#define AI_INPUT_DATA_PAYLOAD_BYTES 12
#define AI_INPUT_CONTROL_FRAME_LEN 12
#define AI_INPUT_DATA_FRAME_HEADER_LEN 8
#define AI_INPUT_STATUS_FRAME_LEN 14

typedef enum {
    AI_INPUT_CONTROL_START = 1,
    AI_INPUT_CONTROL_COMMIT = 2,
    AI_INPUT_DATA_FRAME = 16,
} ai_input_frame_type_t;

typedef struct {
    uint8_t type;
    uint16_t task_id;
    uint32_t total_bytes;
    uint16_t total_chunks;
} ai_input_control_frame_t;

typedef struct {
    uint16_t task_id;
    uint16_t chunk_index;
    uint16_t total_chunks;
    const uint8_t *payload;
    size_t payload_len;
} ai_input_data_frame_t;

bool ai_input_parse_control_frame(const uint8_t *data, size_t len, ai_input_control_frame_t *out);
bool ai_input_parse_data_frame(const uint8_t *data, size_t len, ai_input_data_frame_t *out);
