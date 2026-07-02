#include "remote_input_task.h"

#include <stdlib.h>
#include <string.h>

static uint16_t expected_chunks_for_total(uint32_t total_bytes)
{
    if (total_bytes == 0) {
        return 1;
    }

    return (uint16_t)((total_bytes + REMOTE_INPUT_DATA_PAYLOAD_BYTES - 1) / REMOTE_INPUT_DATA_PAYLOAD_BYTES);
}

static size_t expected_payload_len_for_chunk(const remote_input_task_buffer_t *task, uint16_t chunk_index)
{
    if (task->total_bytes == 0) {
        return 0;
    }

    const uint32_t offset = (uint32_t)chunk_index * REMOTE_INPUT_DATA_PAYLOAD_BYTES;
    const uint32_t remaining = task->total_bytes - offset;
    if (remaining < REMOTE_INPUT_DATA_PAYLOAD_BYTES) {
        return remaining;
    }

    return REMOTE_INPUT_DATA_PAYLOAD_BYTES;
}

static void release_task_memory(remote_input_task_buffer_t *task)
{
    if (task == NULL) {
        return;
    }

    free(task->buffer);
    free(task->chunk_seen);
    task->buffer = NULL;
    task->chunk_seen = NULL;
}

void remote_input_task_init(remote_input_task_buffer_t *task)
{
    if (task == NULL) {
        return;
    }

    memset(task, 0, sizeof(*task));
}

remote_input_error_t remote_input_task_start(remote_input_task_buffer_t *task, const remote_input_control_frame_t *frame)
{
    if (task == NULL || frame == NULL) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }
    if (task->active) {
        return REMOTE_INPUT_ERR_DEVICE_BUSY;
    }
    if (frame->total_bytes > REMOTE_INPUT_MAX_TEXT_BYTES) {
        return REMOTE_INPUT_ERR_TASK_TOO_LARGE;
    }
    if (frame->total_chunks == 0) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }
    if (frame->total_chunks != expected_chunks_for_total(frame->total_bytes)) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }

    uint8_t *buffer = NULL;
    if (frame->total_bytes > 0) {
        buffer = (uint8_t *)calloc(1, frame->total_bytes);
        if (buffer == NULL) {
            return REMOTE_INPUT_ERR_TASK_TOO_LARGE;
        }
    }

    uint8_t *chunk_seen = (uint8_t *)calloc(frame->total_chunks, sizeof(uint8_t));
    if (chunk_seen == NULL) {
        free(buffer);
        return REMOTE_INPUT_ERR_TASK_TOO_LARGE;
    }

    task->task_id = frame->task_id;
    task->total_bytes = frame->total_bytes;
    task->total_chunks = frame->total_chunks;
    task->received_bytes = 0;
    task->received_chunks = 0;
    task->config = (remote_input_config_t) {0};
    task->buffer = buffer;
    task->chunk_seen = chunk_seen;
    task->active = true;
    return REMOTE_INPUT_ERR_OK;
}

remote_input_error_t remote_input_task_add_chunk(remote_input_task_buffer_t *task, const remote_input_data_frame_t *frame)
{
    if (task == NULL || frame == NULL || !task->active) {
        return REMOTE_INPUT_ERR_INVALID_CHUNK;
    }
    if (frame->task_id != task->task_id || frame->total_chunks != task->total_chunks) {
        return REMOTE_INPUT_ERR_INVALID_CHUNK;
    }
    if (frame->chunk_index >= task->total_chunks) {
        return REMOTE_INPUT_ERR_INVALID_CHUNK;
    }
    if (task->chunk_seen[frame->chunk_index] != 0) {
        return REMOTE_INPUT_ERR_DUPLICATE_CHUNK;
    }

    const uint32_t offset = (uint32_t)frame->chunk_index * REMOTE_INPUT_DATA_PAYLOAD_BYTES;
    if (offset > task->total_bytes) {
        return REMOTE_INPUT_ERR_INVALID_CHUNK;
    }

    const size_t expected_payload_len = expected_payload_len_for_chunk(task, frame->chunk_index);
    if (frame->payload_len != expected_payload_len) {
        return REMOTE_INPUT_ERR_INVALID_CHUNK;
    }

    if (frame->payload_len > 0) {
        if (frame->payload == NULL || task->buffer == NULL) {
            return REMOTE_INPUT_ERR_INVALID_CHUNK;
        }
        memcpy(&task->buffer[offset], frame->payload, frame->payload_len);
    }
    task->chunk_seen[frame->chunk_index] = 1;
    task->received_chunks++;
    task->received_bytes += (uint32_t)frame->payload_len;
    return REMOTE_INPUT_ERR_OK;
}

remote_input_error_t remote_input_task_commit(remote_input_task_buffer_t *task, const remote_input_control_frame_t *frame, const uint8_t **bytes, size_t *len)
{
    if (task == NULL || frame == NULL || bytes == NULL || len == NULL || !task->active) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }
    if (frame->task_id != task->task_id || frame->total_bytes != task->total_bytes ||
        frame->total_chunks != task->total_chunks) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }
    if (task->received_chunks != task->total_chunks || task->received_bytes != task->total_bytes) {
        return REMOTE_INPUT_ERR_MISSING_CHUNK;
    }

    *bytes = task->buffer;
    *len = task->total_bytes;
    return REMOTE_INPUT_ERR_OK;
}

void remote_input_task_reset(remote_input_task_buffer_t *task)
{
    if (task == NULL) {
        return;
    }

    release_task_memory(task);
    memset(task, 0, sizeof(*task));
}
