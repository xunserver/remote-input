#include "ai_input_task.h"

#include <string.h>

#define AI_INPUT_CHUNK_SEEN_LEN ((uint16_t)(sizeof(((ai_input_task_buffer_t *)0)->chunk_seen) / sizeof(uint8_t)))

void ai_input_task_init(ai_input_task_buffer_t *task)
{
    if (task == NULL) {
        return;
    }

    memset(task, 0, sizeof(*task));
}

ai_input_error_t ai_input_task_start(ai_input_task_buffer_t *task, const ai_input_control_frame_t *frame)
{
    if (task == NULL || frame == NULL) {
        return AI_INPUT_ERR_INVALID_COMMAND;
    }
    if (task->active) {
        return AI_INPUT_ERR_DEVICE_BUSY;
    }
    if (frame->total_bytes > AI_INPUT_MAX_TEXT_BYTES) {
        return AI_INPUT_ERR_TASK_TOO_LARGE;
    }
    if (frame->total_chunks == 0) {
        return AI_INPUT_ERR_INVALID_COMMAND;
    }
    if (frame->total_chunks > AI_INPUT_CHUNK_SEEN_LEN) {
        return AI_INPUT_ERR_TASK_TOO_LARGE;
    }

    task->task_id = frame->task_id;
    task->total_bytes = frame->total_bytes;
    task->total_chunks = frame->total_chunks;
    task->received_bytes = 0;
    task->received_chunks = 0;
    memset(task->buffer, 0, sizeof(task->buffer));
    memset(task->chunk_seen, 0, sizeof(task->chunk_seen));
    task->active = true;
    return AI_INPUT_ERR_OK;
}

ai_input_error_t ai_input_task_add_chunk(ai_input_task_buffer_t *task, const ai_input_data_frame_t *frame)
{
    if (task == NULL || frame == NULL || !task->active) {
        return AI_INPUT_ERR_INVALID_CHUNK;
    }
    if (frame->task_id != task->task_id || frame->total_chunks != task->total_chunks) {
        return AI_INPUT_ERR_INVALID_CHUNK;
    }
    if (frame->chunk_index >= task->total_chunks) {
        return AI_INPUT_ERR_INVALID_CHUNK;
    }
    if (task->chunk_seen[frame->chunk_index] != 0) {
        return AI_INPUT_ERR_DUPLICATE_CHUNK;
    }

    const uint32_t offset = (uint32_t)frame->chunk_index * AI_INPUT_DATA_PAYLOAD_BYTES;
    if (frame->payload_len > task->total_bytes || offset > task->total_bytes - frame->payload_len) {
        return AI_INPUT_ERR_INVALID_CHUNK;
    }

    if (frame->payload_len > 0) {
        if (frame->payload == NULL) {
            return AI_INPUT_ERR_INVALID_CHUNK;
        }
        memcpy(&task->buffer[offset], frame->payload, frame->payload_len);
    }
    task->chunk_seen[frame->chunk_index] = 1;
    task->received_chunks++;
    task->received_bytes += (uint32_t)frame->payload_len;
    return AI_INPUT_ERR_OK;
}

ai_input_error_t ai_input_task_commit(ai_input_task_buffer_t *task, const ai_input_control_frame_t *frame, const uint8_t **bytes, size_t *len)
{
    if (task == NULL || frame == NULL || bytes == NULL || len == NULL || !task->active) {
        return AI_INPUT_ERR_INVALID_COMMAND;
    }
    if (frame->task_id != task->task_id || frame->total_bytes != task->total_bytes ||
        frame->total_chunks != task->total_chunks) {
        return AI_INPUT_ERR_INVALID_COMMAND;
    }
    if (task->received_chunks != task->total_chunks || task->received_bytes != task->total_bytes) {
        return AI_INPUT_ERR_MISSING_CHUNK;
    }

    *bytes = task->buffer;
    *len = task->total_bytes;
    return AI_INPUT_ERR_OK;
}

void ai_input_task_reset(ai_input_task_buffer_t *task)
{
    if (task == NULL) {
        return;
    }

    memset(task, 0, sizeof(*task));
}
