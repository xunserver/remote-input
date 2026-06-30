#include "remote_input_service.h"

#include "remote_input_ble.h"
#include "remote_input_hid.h"
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

static void run_typing_task(uint16_t task_id, const uint8_t *bytes, size_t len)
{
    remote_input_status_set(REMOTE_INPUT_STATE_TYPING, task_id, REMOTE_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);
    remote_input_ble_notify_status();

    bool valid = remote_input_utf8_decode_each(bytes, len, validate_codepoint_cb, NULL);
    if (!valid) {
        remote_input_status_set(REMOTE_INPUT_STATE_ERROR, task_id, REMOTE_INPUT_ERR_INVALID_UTF8, (uint32_t)len, (uint32_t)len);
        remote_input_ble_notify_status();
        return;
    }

    if (!remote_input_hid_ready()) {
        remote_input_status_set(REMOTE_INPUT_STATE_ERROR, task_id, REMOTE_INPUT_ERR_USB_NOT_READY, (uint32_t)len, (uint32_t)len);
        remote_input_ble_notify_status();
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
        remote_input_status_set(REMOTE_INPUT_STATE_ERROR, task_id, error, (uint32_t)len, (uint32_t)len);
        remote_input_ble_notify_status();
        return;
    }

    remote_input_status_set(REMOTE_INPUT_STATE_DONE, task_id, REMOTE_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);
    remote_input_ble_notify_status();
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
            remote_input_status_set(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_DEVICE_BUSY, 0, frame->total_bytes);
            remote_input_ble_notify_status();
            return;
        }

        reset_receive_task();
        err = remote_input_task_start(&g_task, frame);
        if (err == REMOTE_INPUT_ERR_OK) {
            remote_input_status_set(REMOTE_INPUT_STATE_RECEIVING, frame->task_id, REMOTE_INPUT_ERR_OK, 0, frame->total_bytes);
        } else {
            remote_input_status_set(REMOTE_INPUT_STATE_ERROR, frame->task_id, err, 0, frame->total_bytes);
        }
        remote_input_ble_notify_status();
        return;
    }

    if (frame->type == REMOTE_INPUT_CONTROL_COMMIT) {
        err = remote_input_task_commit(&g_task, frame, &g_pending_bytes, &g_pending_len);
        if (err != REMOTE_INPUT_ERR_OK) {
            remote_input_status_set(REMOTE_INPUT_STATE_ERROR, frame->task_id, err, g_task.received_bytes, frame->total_bytes);
            remote_input_ble_notify_status();
            reset_pending_task();
            return;
        }

        if (!reserve_typing_worker()) {
            remote_input_status_set(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_DEVICE_BUSY, g_task.received_bytes, frame->total_bytes);
            remote_input_ble_notify_status();
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
            remote_input_status_set(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_DEVICE_BUSY, received_bytes, total_bytes);
            remote_input_ble_notify_status();
            set_typing_active(false);
            return;
        }

        return;
    }

    remote_input_status_set(REMOTE_INPUT_STATE_ERROR, frame->task_id, REMOTE_INPUT_ERR_INVALID_COMMAND, 0, frame->total_bytes);
    remote_input_ble_notify_status();
}

static void on_data(const remote_input_data_frame_t *frame)
{
    remote_input_error_t err = remote_input_task_add_chunk(&g_task, frame);
    if (err == REMOTE_INPUT_ERR_OK) {
        remote_input_status_set(REMOTE_INPUT_STATE_RECEIVING, frame->task_id, REMOTE_INPUT_ERR_OK, g_task.received_bytes, g_task.total_bytes);
        remote_input_ble_notify_status();
        return;
    }

    uint32_t received = g_task.received_bytes;
    uint32_t total = g_task.total_bytes;
    remote_input_status_set(REMOTE_INPUT_STATE_ERROR, frame->task_id, err, received, total);
    remote_input_ble_notify_status();
    reset_pending_task();
}

static void on_disconnect(void)
{
    if (!is_typing_active()) {
        if (g_task.active) {
            remote_input_status_set(REMOTE_INPUT_STATE_IDLE, 0, REMOTE_INPUT_ERR_OK, 0, 0);
        }
        reset_receive_task();
    }
}

esp_err_t remote_input_service_init(void)
{
    remote_input_status_init();
    remote_input_task_init(&g_task);

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
