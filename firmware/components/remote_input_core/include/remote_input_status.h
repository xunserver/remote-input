#pragma once

#include <stdint.h>

typedef enum {
    REMOTE_INPUT_STATE_IDLE = 0,
    REMOTE_INPUT_STATE_RECEIVING = 1,
    REMOTE_INPUT_STATE_TYPING = 2,
    REMOTE_INPUT_STATE_DONE = 3,
    REMOTE_INPUT_STATE_ERROR = 4,
} remote_input_state_t;

typedef enum {
    REMOTE_INPUT_ERR_OK = 0,
    REMOTE_INPUT_ERR_DEVICE_BUSY = 1,
    REMOTE_INPUT_ERR_INVALID_COMMAND = 2,
    REMOTE_INPUT_ERR_INVALID_CHUNK = 3,
    REMOTE_INPUT_ERR_DUPLICATE_CHUNK = 4,
    REMOTE_INPUT_ERR_MISSING_CHUNK = 5,
    REMOTE_INPUT_ERR_TASK_TOO_LARGE = 6,
    REMOTE_INPUT_ERR_INVALID_UTF8 = 7,
    REMOTE_INPUT_ERR_INVALID_CODEPOINT = 8,
    REMOTE_INPUT_ERR_USB_NOT_READY = 9,
    REMOTE_INPUT_ERR_HID_INPUT_FAILED = 10,
} remote_input_error_t;

typedef struct {
    remote_input_state_t state;
    uint16_t last_task_id;
    remote_input_error_t last_error;
    uint32_t received_bytes;
    uint32_t total_bytes;
} remote_input_status_t;

void remote_input_status_init(void);
void remote_input_status_set(remote_input_state_t state, uint16_t task_id, remote_input_error_t error, uint32_t received, uint32_t total);
remote_input_status_t remote_input_status_get(void);
void remote_input_status_encode(uint8_t out[14]);
