#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define REMOTE_INPUT_PROTOCOL_VERSION 1
#define REMOTE_INPUT_MAX_TEXT_BYTES (16 * 1024)
#define REMOTE_INPUT_DATA_PAYLOAD_BYTES 12
#define REMOTE_INPUT_CONTROL_FRAME_LEN 12
#define REMOTE_INPUT_DATA_FRAME_HEADER_LEN 8
#define REMOTE_INPUT_STATUS_FRAME_LEN 14
#define REMOTE_INPUT_KEY_DELAY_DEFAULT_MS 20
#define REMOTE_INPUT_KEY_DELAY_MIN_MS 1
#define REMOTE_INPUT_KEY_DELAY_MAX_MS 200

typedef enum {
    REMOTE_INPUT_CONTROL_START = 1,
    REMOTE_INPUT_CONTROL_COMMIT = 2,
    REMOTE_INPUT_CONTROL_CONFIG = 3,
    REMOTE_INPUT_DATA_FRAME = 16,
} remote_input_frame_type_t;

typedef struct {
    uint8_t type;
    uint16_t task_id;
    uint32_t total_bytes;
    uint16_t total_chunks;
} remote_input_control_frame_t;

typedef struct {
    uint16_t task_id;
    uint16_t chunk_index;
    uint16_t total_chunks;
    const uint8_t *payload;
    size_t payload_len;
} remote_input_data_frame_t;

typedef struct {
    uint16_t key_delay_ms;
} remote_input_config_frame_t;

bool remote_input_parse_control_frame(const uint8_t *data, size_t len, remote_input_control_frame_t *out);
bool remote_input_parse_data_frame(const uint8_t *data, size_t len, remote_input_data_frame_t *out);
bool remote_input_parse_config_frame(const uint8_t *data, size_t len, remote_input_config_frame_t *out);
