#include "ai_input_ble.h"
#include "ai_input_hid.h"
#include "ai_input_status.h"
#include "ai_input_task.h"
#include "ai_input_utf8.h"

#include "esp_err.h"
#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include <string.h>

#define AI_INPUT_TYPING_QUEUE_LEN 1
#define AI_INPUT_TYPING_WORKER_STACK_SIZE 6144
#define AI_INPUT_TYPING_WORKER_PRIORITY 5

static const char *TAG = "ai_input";
static ai_input_task_buffer_t g_task;
static const uint8_t *g_pending_bytes = NULL;
static size_t g_pending_len = 0;
static QueueHandle_t g_typing_queue;
static volatile bool g_typing_active;
static portMUX_TYPE g_typing_lock = portMUX_INITIALIZER_UNLOCKED;

typedef struct {
    uint16_t task_id;
    size_t len;
    uint8_t bytes[AI_INPUT_MAX_TEXT_BYTES];
} typing_job_t;

static typing_job_t g_pending_job;

typedef struct {
    ai_input_error_t error;
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
    ai_input_task_reset(&g_task);
    g_pending_bytes = NULL;
    g_pending_len = 0;
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
    esp_err_t err = ai_input_hid_type_codepoint(codepoint);
    if (err != ESP_OK) {
        if (typing_ctx != NULL) {
            typing_ctx->error = (err == ESP_ERR_INVALID_STATE) ? AI_INPUT_ERR_USB_NOT_READY : AI_INPUT_ERR_HID_INPUT_FAILED;
        }
        return false;
    }

    return true;
}

static void run_typing_task(uint16_t task_id, const uint8_t *bytes, size_t len)
{
    ai_input_status_set(AI_INPUT_STATE_TYPING, task_id, AI_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);
    ai_input_ble_notify_status();

    bool valid = ai_input_utf8_decode_each(bytes, len, validate_codepoint_cb, NULL);
    if (!valid) {
        ai_input_status_set(AI_INPUT_STATE_ERROR, task_id, AI_INPUT_ERR_INVALID_UTF8, (uint32_t)len, (uint32_t)len);
        ai_input_ble_notify_status();
        return;
    }

    if (!ai_input_hid_ready()) {
        ai_input_status_set(AI_INPUT_STATE_ERROR, task_id, AI_INPUT_ERR_USB_NOT_READY, (uint32_t)len, (uint32_t)len);
        ai_input_ble_notify_status();
        return;
    }

    typing_context_t typing_ctx = {
        .error = AI_INPUT_ERR_OK,
    };
    bool ok = ai_input_utf8_decode_each(bytes, len, type_codepoint_cb, &typing_ctx);
    if (!ok) {
        ai_input_error_t error = typing_ctx.error;
        if (error == AI_INPUT_ERR_OK) {
            error = AI_INPUT_ERR_INVALID_UTF8;
        }
        ai_input_status_set(AI_INPUT_STATE_ERROR, task_id, error, (uint32_t)len, (uint32_t)len);
        ai_input_ble_notify_status();
        return;
    }

    ai_input_status_set(AI_INPUT_STATE_DONE, task_id, AI_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);
    ai_input_ble_notify_status();
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

static void on_control(const ai_input_control_frame_t *frame)
{
    ai_input_error_t err = AI_INPUT_ERR_OK;

    if (frame->type == AI_INPUT_CONTROL_START) {
        if (is_typing_active()) {
            ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, AI_INPUT_ERR_DEVICE_BUSY, 0, frame->total_bytes);
            ai_input_ble_notify_status();
            return;
        }

        err = ai_input_task_start(&g_task, frame);
        if (err == AI_INPUT_ERR_OK) {
            ai_input_status_set(AI_INPUT_STATE_RECEIVING, frame->task_id, AI_INPUT_ERR_OK, 0, frame->total_bytes);
        } else {
            ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, err, 0, frame->total_bytes);
        }
        ai_input_ble_notify_status();
        return;
    }

    if (frame->type == AI_INPUT_CONTROL_COMMIT) {
        err = ai_input_task_commit(&g_task, frame, &g_pending_bytes, &g_pending_len);
        if (err != AI_INPUT_ERR_OK) {
            ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, err, g_task.received_bytes, frame->total_bytes);
            ai_input_ble_notify_status();
            reset_pending_task();
            return;
        }

        if (!reserve_typing_worker()) {
            ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, AI_INPUT_ERR_DEVICE_BUSY, g_task.received_bytes, frame->total_bytes);
            ai_input_ble_notify_status();
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
            ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, AI_INPUT_ERR_DEVICE_BUSY, received_bytes, total_bytes);
            ai_input_ble_notify_status();
            set_typing_active(false);
            return;
        }

        return;
    }

    ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, AI_INPUT_ERR_INVALID_COMMAND, 0, frame->total_bytes);
    ai_input_ble_notify_status();
}

static void on_data(const ai_input_data_frame_t *frame)
{
    ai_input_error_t err = ai_input_task_add_chunk(&g_task, frame);
    if (err == AI_INPUT_ERR_OK) {
        ai_input_status_set(AI_INPUT_STATE_RECEIVING, frame->task_id, AI_INPUT_ERR_OK, g_task.received_bytes, g_task.total_bytes);
        ai_input_ble_notify_status();
        return;
    }

    uint32_t received = g_task.received_bytes;
    uint32_t total = g_task.total_bytes;
    ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, err, received, total);
    ai_input_ble_notify_status();
    reset_pending_task();
}

void app_main(void)
{
    ESP_LOGI(TAG, "AI Input firmware booting");

    ai_input_status_init();
    ai_input_task_init(&g_task);
    g_typing_queue = xQueueCreate(AI_INPUT_TYPING_QUEUE_LEN, sizeof(typing_job_t *));
    ESP_ERROR_CHECK(g_typing_queue == NULL ? ESP_ERR_NO_MEM : ESP_OK);
    BaseType_t worker_created = xTaskCreate(typing_worker_task,
                                            "ai_input_typing",
                                            AI_INPUT_TYPING_WORKER_STACK_SIZE,
                                            NULL,
                                            AI_INPUT_TYPING_WORKER_PRIORITY,
                                            NULL);
    ESP_ERROR_CHECK(worker_created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(ai_input_hid_init());

    const ai_input_ble_callbacks_t callbacks = {
        .on_control = on_control,
        .on_data = on_data,
    };
    ESP_ERROR_CHECK(ai_input_ble_init(&callbacks));

    ESP_LOGI(TAG, "AI Input ready");
}
