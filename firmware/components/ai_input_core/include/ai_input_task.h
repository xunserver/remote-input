#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ai_input_protocol.h"
#include "ai_input_status.h"

typedef struct {
    uint16_t task_id;
    uint32_t total_bytes;
    uint16_t total_chunks;
    uint32_t received_bytes;
    uint16_t received_chunks;
    uint8_t buffer[AI_INPUT_MAX_TEXT_BYTES];
    uint8_t chunk_seen[(AI_INPUT_MAX_TEXT_BYTES / AI_INPUT_DATA_PAYLOAD_BYTES) + 2];
    bool active;
} ai_input_task_buffer_t;

void ai_input_task_init(ai_input_task_buffer_t *task);
ai_input_error_t ai_input_task_start(ai_input_task_buffer_t *task, const ai_input_control_frame_t *frame);
ai_input_error_t ai_input_task_add_chunk(ai_input_task_buffer_t *task, const ai_input_data_frame_t *frame);
ai_input_error_t ai_input_task_commit(ai_input_task_buffer_t *task, const ai_input_control_frame_t *frame, const uint8_t **bytes, size_t *len);
void ai_input_task_reset(ai_input_task_buffer_t *task);
