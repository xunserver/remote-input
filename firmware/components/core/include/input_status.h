#pragma once

#include <stdint.h>

typedef enum {
    INPUT_STATE_IDLE = 0,
    INPUT_STATE_RECEIVING = 1,
    INPUT_STATE_TYPING = 2,
    INPUT_STATE_DONE = 3,
    INPUT_STATE_ERROR = 4,
} input_state_t;

typedef enum {
    INPUT_ERR_OK = 0,
    INPUT_ERR_DEVICE_BUSY = 1,
    INPUT_ERR_INVALID_COMMAND = 2,
    INPUT_ERR_INVALID_CHUNK = 3,
    INPUT_ERR_DUPLICATE_CHUNK = 4,
    INPUT_ERR_MISSING_CHUNK = 5,
    INPUT_ERR_TASK_TOO_LARGE = 6,
    INPUT_ERR_INVALID_UTF8 = 7,
    INPUT_ERR_INVALID_CODEPOINT = 8,
    INPUT_ERR_USB_NOT_READY = 9,
    INPUT_ERR_HID_INPUT_FAILED = 10,
} input_error_t;

typedef struct {
    input_state_t state;
    uint16_t last_task_id;
    input_error_t last_error;
    uint32_t received_bytes;
    uint32_t total_bytes;
} input_status_t;

void input_status_init(void);
void input_status_set(input_state_t state, uint16_t task_id, input_error_t error, uint32_t received, uint32_t total);
input_status_t input_status_get(void);
void input_status_encode(uint8_t out[14]);
