#pragma once

#include <stdint.h>

typedef enum {
    AI_INPUT_STATE_IDLE = 0,
    AI_INPUT_STATE_RECEIVING = 1,
    AI_INPUT_STATE_TYPING = 2,
    AI_INPUT_STATE_DONE = 3,
    AI_INPUT_STATE_ERROR = 4,
} ai_input_state_t;

typedef enum {
    AI_INPUT_ERR_OK = 0,
    AI_INPUT_ERR_DEVICE_BUSY = 1,
    AI_INPUT_ERR_INVALID_COMMAND = 2,
    AI_INPUT_ERR_INVALID_CHUNK = 3,
    AI_INPUT_ERR_DUPLICATE_CHUNK = 4,
    AI_INPUT_ERR_MISSING_CHUNK = 5,
    AI_INPUT_ERR_TASK_TOO_LARGE = 6,
    AI_INPUT_ERR_INVALID_UTF8 = 7,
    AI_INPUT_ERR_INVALID_CODEPOINT = 8,
    AI_INPUT_ERR_USB_NOT_READY = 9,
    AI_INPUT_ERR_HID_INPUT_FAILED = 10,
} ai_input_error_t;

typedef struct {
    ai_input_state_t state;
    uint16_t last_task_id;
    ai_input_error_t last_error;
    uint32_t received_bytes;
    uint32_t total_bytes;
} ai_input_status_t;

void ai_input_status_init(void);
void ai_input_status_set(ai_input_state_t state, uint16_t task_id, ai_input_error_t error, uint32_t received, uint32_t total);
ai_input_status_t ai_input_status_get(void);
void ai_input_status_encode(uint8_t out[14]);
