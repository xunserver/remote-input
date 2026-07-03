#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define INPUT_PROTOCOL_VERSION 2
#define INPUT_MAX_TEXT_BYTES (128 * 1024)
#define INPUT_DATA_PAYLOAD_BYTES 180
#define INPUT_CONTROL_FRAME_LEN 12
#define INPUT_DATA_FRAME_HEADER_LEN 8
#define INPUT_STATUS_FRAME_LEN 14
#define INPUT_KEY_DELAY_DEFAULT_MS 20
#define INPUT_KEY_DELAY_MIN_MS 1
#define INPUT_KEY_DELAY_MAX_MS 200

typedef enum {
    INPUT_CONTROL_START = 1,
    INPUT_CONTROL_COMMIT = 2,
    INPUT_CONTROL_CONFIG = 3,
    INPUT_DATA_FRAME = 16,
} input_frame_type_t;

typedef struct {
    uint8_t type;
    uint16_t task_id;
    uint32_t total_bytes;
    uint16_t total_chunks;
} input_control_frame_t;

typedef struct {
    uint16_t task_id;
    uint16_t chunk_index;
    uint16_t total_chunks;
    const uint8_t *payload;
    size_t payload_len;
} input_data_frame_t;

typedef struct {
    uint16_t key_delay_ms;
} input_config_frame_t;

typedef struct {
    uint16_t key_delay_ms;
} input_config_t;

bool input_parse_control_frame(const uint8_t *data, size_t len, input_control_frame_t *out);
bool input_parse_data_frame(const uint8_t *data, size_t len, input_data_frame_t *out);
bool input_parse_config_frame(const uint8_t *data, size_t len, input_config_frame_t *out);
