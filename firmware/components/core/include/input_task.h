#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "input_protocol.h"
#include "input_status.h"

typedef struct {
    uint16_t task_id;
    uint32_t total_bytes;
    uint16_t total_chunks;
    uint32_t received_bytes;
    uint16_t received_chunks;
    input_config_t config;
    uint8_t *buffer;
    uint8_t *chunk_seen;
    bool active;
} input_task_buffer_t;

void input_task_init(input_task_buffer_t *task);
input_error_t input_task_start(input_task_buffer_t *task, const input_control_frame_t *frame);
input_error_t input_task_add_chunk(input_task_buffer_t *task, const input_data_frame_t *frame);
input_error_t input_task_commit(input_task_buffer_t *task, const input_control_frame_t *frame, const uint8_t **bytes, size_t *len);
void input_task_reset(input_task_buffer_t *task);
