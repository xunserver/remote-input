#include "remote_input_service.h"

#include "remote_input_ble.h"
#include "remote_input_display.h"
#include "remote_input_firmware_version.h"
#include "remote_input_hid.h"
#include "remote_input_led.h"
#include "remote_input_status.h"
#include "remote_input_task.h"
#include "remote_input_utf8.h"

#include "esp_err.h"
#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include <string.h>

#define REMOTE_INPUT_TYPING_QUEUE_LEN 1
#define REMOTE_INPUT_TYPING_WORKER_STACK_SIZE 6144
#define REMOTE_INPUT_TYPING_WORKER_PRIORITY 5

static const char *TAG = "remote_input_service";
static remote_input_task_buffer_t g_task;
static const uint8_t *g_pending_bytes = NULL;
static size_t g_pending_len = 0;
static QueueHandle_t g_typing_queue;
static volatile bool g_typing_active;
static portMUX_TYPE g_typing_lock = portMUX_INITIALIZER_UNLOCKED;

typedef struct {
    uint16_t task_id;
    size_t len;
    uint8_t bytes[REMOTE_INPUT_MAX_TEXT_BYTES];
} typing_job_t;

static typing_job_t g_pending_job;

typedef struct {
    remote_input_error_t error;
} typing_context_t;

static bool reserve_typing_worker(void)
{
    bool reserved = false;

    portENTER_CRITICAL(&g_typing_lock);
    if (!g_typing_active) {
        g_typing_active = true;
        reserved = true;
    }
    portEXIT_CRITICAL(&g_typing_lock);

    return reserved;
}

static bool is_typing_active(void)
{
    bool active;

    portENTER_CRITICAL(&g_typing_lock);
    active = g_typing_active;
    portEXIT_CRITICAL(&g_typing_lock);

    return active;
}

static void set_typing_active(bool active)
{
    portENTER_CRITICAL(&g_typing_lock);
    g_typing_active = active;
    portEXIT_CRITICAL(&g_typing_lock);
}

static void reset_pending_task(void)
{
    remote_input_task_reset(&g_task);
    g_pending_bytes = NULL;
    g_pending_len = 0;
}

static void reset_receive_task(void)
{
    if (g_task.active) {
        reset_pending_task();
    }
}

static void update_status(remote_input_state_t state,
                          uint16_t task_id,
                          remote_input_error_t error,
                          uint32_t received,
                          uint32_t total)
{
    remote_input_status_set(state, task_id, error, received, total);
    remote_input_display_set_input_state(state);
    remote_input_ble_notify_status();
}

static bool validate_codepoint_cb(uint32_t codepoint, void *ctx)
{
    (void)codepoint;
    (void)ctx;
    return true;
}

static bool type_codepoint_cb(uint32_t codepoint, void *ctx)
{
    typing_context_t *typing_ctx = (typing_context_t *)ctx;
    esp_err_t err = remote_input_hid_type_codepoint(codepoint);
    if (err != ESP_OK) {
        if (typing_ctx != NULL) {
            if (err == ESP_ERR_INVALID_STATE) {
                typing_ctx->error = REMOTE_INPUT_ERR_USB_NOT_READY;
            } else if (err == ESP_ERR_INVALID_ARG) {
                typing_ctx->error = REMOTE_INPUT_ERR_INVALID_CODEPOINT;
            } else {
                typing_ctx->error = REMOTE_INPUT_ERR_HID_INPUT_FAILED;
            }
        }
        return false;
    }

    return true;
}

static void finish_typing_with_status(remote_input_state_t state,
                                      uint16_t task_id,
                                      remote_input_error_t error,
                                      size_t len)
{
    update_status(state, task_id, error, (uint32_t)len, (uint32_t)len);
    remote_input_led_set_typing(false);
}

static void run_typing_task(uint16_t task_id, const uint8_t *bytes, size_t len)
{
    remote_input_led_set_typing(true);
    update_status(REMOTE_INPUT_STATE_TYPING, task_id, REMOTE_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);

    bool valid = remote_input_utf8_decode_each(bytes, len, validate_codepoint_cb, NULL);
    if (!valid) {
        finish_typing_with_status(REMOTE_INPUT_STATE_ERROR, task_id, REMOTE_INPUT_ERR_INVALID_UTF8, len);
        return;
    }

    if (!remote_input_hid_ready()) {
        finish_typing_with_status(REMOTE_INPUT_STATE_ERROR, task_id, REMOTE_INPUT_ERR_USB_NOT_READY, len);
        return;
    }

    typing_context_t typing_ctx = {
        .error = REMOTE_INPUT_ERR_OK,
    };
    bool ok = remote_input_utf8_decode_each(bytes, len, type_codepoint_cb, &typing_ctx);
    if (!ok) {
        remote_input_error_t error = typing_ctx.error;
        if (error == REMOTE_INPUT_ERR_OK) {
            error = REMOTE_INPUT_ERR_INVALID_UTF8;
        }
        finish_typing_with_status(REMOTE_INPUT_STATE_ERROR, task_id, error, len);
        return;
    }

    finish_typing_with_status(REMOTE_INPUT_STATE_DONE, task_id, REMOTE_INPUT_ERR_OK, len);
}

static void typing_worker_task(void *ctx)
{
    (void)ctx;

    for (;;) {
        typing_job_t *job = NULL;
        if (xQueueReceive(g_typing_queue, &job, portMAX_DELAY) == pdTRUE && job != NULL) {
            run_typing_task(job->task_id, job->bytes, job->len);
        }
        set_typing_active(false);
    }
}

static void on_control(const remote_input_control_frame_t *frame)
{
    remote_input_error_t err = REMOTE_INPUT_ERR_OK;

    if (frame->type == REMOTE_INPUT_CONTROL_START) {
        if (is_typing_active()) {
            update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_DEVICE_BUSY, 0, frame->total_bytes);
            return;
        }

        reset_receive_task();
        err = remote_input_task_start(&g_task, frame);
        if (err == REMOTE_INPUT_ERR_OK) {
            update_status(REMOTE_INPUT_STATE_RECEIVING, frame->task_id, REMOTE_INPUT_ERR_OK, 0, frame->total_bytes);
        } else {
            update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, err, 0, frame->total_bytes);
        }
        return;
    }

    if (frame->type == REMOTE_INPUT_CONTROL_COMMIT) {
        err = remote_input_task_commit(&g_task, frame, &g_pending_bytes, &g_pending_len);
        if (err != REMOTE_INPUT_ERR_OK) {
            update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, err, g_task.received_bytes, frame->total_bytes);
            reset_pending_task();
            return;
        }

        if (!reserve_typing_worker()) {
            update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_DEVICE_BUSY, g_task.received_bytes, frame->total_bytes);
            reset_pending_task();
            return;
        }

        uint32_t received_bytes = g_task.received_bytes;
        uint32_t total_bytes = g_task.total_bytes;
        g_pending_job.task_id = frame->task_id;
        g_pending_job.len = g_pending_len;
        if (g_pending_len > 0) {
            memcpy(g_pending_job.bytes, g_pending_bytes, g_pending_len);
        }
        reset_pending_task();

        typing_job_t *job = &g_pending_job;
        if (g_typing_queue == NULL || xQueueSend(g_typing_queue, &job, 0) != pdTRUE) {
            update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_DEVICE_BUSY, received_bytes, total_bytes);
            set_typing_active(false);
            return;
        }

        return;
    }

    update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_INVALID_COMMAND, 0, frame->total_bytes);
}

static void on_data(const remote_input_data_frame_t *frame)
{
    remote_input_error_t err = remote_input_task_add_chunk(&g_task, frame);
    if (err == REMOTE_INPUT_ERR_OK) {
        update_status(REMOTE_INPUT_STATE_RECEIVING, frame->task_id, REMOTE_INPUT_ERR_OK, g_task.received_bytes, g_task.total_bytes);
        return;
    }

    uint32_t received = g_task.received_bytes;
    uint32_t total = g_task.total_bytes;
    update_status(REMOTE_INPUT_STATE_ERROR, frame->task_id, err, received, total);
    reset_pending_task();
}

static void on_connect(void)
{
    remote_input_led_set_connected(true);
    remote_input_display_set_ble_connected(true);
}

static void on_disconnect(void)
{
    remote_input_led_set_connected(false);
    remote_input_display_set_ble_connected(false);

    if (!is_typing_active()) {
        if (g_task.active) {
            update_status(REMOTE_INPUT_STATE_IDLE, 0, REMOTE_INPUT_ERR_OK, 0, 0);
        }
        reset_receive_task();
    }
}

esp_err_t remote_input_service_init(void)
{
    remote_input_status_init();
    remote_input_task_init(&g_task);

    esp_err_t led_err = remote_input_led_init();
    if (led_err != ESP_OK) {
        ESP_LOGE(TAG, "led init failed: %s", esp_err_to_name(led_err));
    }

    esp_err_t display_err = remote_input_display_init(REMOTE_INPUT_FIRMWARE_VERSION);
    if (display_err != ESP_OK) {
        ESP_LOGE(TAG, "display init failed: %s", esp_err_to_name(display_err));
    }

    g_typing_queue = xQueueCreate(REMOTE_INPUT_TYPING_QUEUE_LEN, sizeof(typing_job_t *));
    if (g_typing_queue == NULL) {
        return ESP_ERR_NO_MEM;
    }

    BaseType_t worker_created = xTaskCreate(typing_worker_task,
                                            "remote_input_typing",
                                            REMOTE_INPUT_TYPING_WORKER_STACK_SIZE,
                                            NULL,
                                            REMOTE_INPUT_TYPING_WORKER_PRIORITY,
                                            NULL);
    if (worker_created != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    esp_err_t err = remote_input_hid_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "hid init failed: %s", esp_err_to_name(err));
        return err;
    }

    const remote_input_ble_callbacks_t callbacks = {
        .on_connect = on_connect,
        .on_control = on_control,
        .on_data = on_data,
        .on_disconnect = on_disconnect,
    };
    err = remote_input_ble_init(&callbacks);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ble init failed: %s", esp_err_to_name(err));
        return err;
    }

    return ESP_OK;
}
