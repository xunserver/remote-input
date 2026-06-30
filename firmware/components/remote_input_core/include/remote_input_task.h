#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "remote_input_protocol.h"
#include "remote_input_status.h"

typedef struct {
    uint16_t task_id;
    uint32_t total_bytes;
    uint16_t total_chunks;
    uint32_t received_bytes;
    uint16_t received_chunks;
    uint8_t buffer[REMOTE_INPUT_MAX_TEXT_BYTES];
    uint8_t chunk_seen[(REMOTE_INPUT_MAX_TEXT_BYTES / REMOTE_INPUT_DATA_PAYLOAD_BYTES) + 2];
    bool active;
} remote_input_task_buffer_t;

void remote_input_task_init(remote_input_task_buffer_t *task);
remote_input_error_t remote_input_task_start(remote_input_task_buffer_t *task, const remote_input_control_frame_t *frame);
remote_input_error_t remote_input_task_add_chunk(remote_input_task_buffer_t *task, const remote_input_data_frame_t *frame);
remote_input_error_t remote_input_task_commit(remote_input_task_buffer_t *task, const remote_input_control_frame_t *frame, const uint8_t **bytes, size_t *len);
void remote_input_task_reset(remote_input_task_buffer_t *task);
