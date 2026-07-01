#include "remote_input_writer_runner.h"

#include "remote_input_protocol.h"

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include <string.h>

#define REMOTE_INPUT_WRITER_QUEUE_LEN 1
#define REMOTE_INPUT_WRITER_STACK_SIZE 6144
#define REMOTE_INPUT_WRITER_PRIORITY 5

typedef struct {
    uint16_t task_id;
    size_t len;
    uint8_t bytes[REMOTE_INPUT_MAX_TEXT_BYTES];
} writer_job_t;

static const remote_input_writer_t *s_writer;
static remote_input_writer_runner_callbacks_t s_callbacks;
static QueueHandle_t s_queue;
static writer_job_t s_pending_job;
static volatile bool s_active;
static bool s_initialized;
static portMUX_TYPE s_active_lock = portMUX_INITIALIZER_UNLOCKED;

static bool reserve_writer(void)
{
    bool reserved = false;

    portENTER_CRITICAL(&s_active_lock);
    if (!s_active) {
        s_active = true;
        reserved = true;
    }
    portEXIT_CRITICAL(&s_active_lock);

    return reserved;
}

static void set_active(bool active)
{
    portENTER_CRITICAL(&s_active_lock);
    s_active = active;
    portEXIT_CRITICAL(&s_active_lock);
}

static void notify_status(remote_input_state_t state,
                          uint16_t task_id,
                          remote_input_error_t error,
                          uint32_t received,
                          uint32_t total)
{
    if (s_callbacks.on_status != NULL) {
        s_callbacks.on_status(state, task_id, error, received, total, s_callbacks.ctx);
    }
}

static void notify_typing(bool typing)
{
    if (s_callbacks.on_typing != NULL) {
        s_callbacks.on_typing(typing, s_callbacks.ctx);
    }
}

static remote_input_error_t write_job(const writer_job_t *job)
{
    if (job == NULL || s_writer == NULL || s_writer->write_text == NULL) {
        return REMOTE_INPUT_ERR_HID_INPUT_FAILED;
    }

    return s_writer->write_text(job->bytes, job->len, s_writer->ctx);
}

static void writer_worker_task(void *ctx)
{
    (void)ctx;

    for (;;) {
        writer_job_t *job = NULL;
        if (xQueueReceive(s_queue, &job, portMAX_DELAY) != pdTRUE || job == NULL) {
            continue;
        }

        notify_typing(true);
        notify_status(REMOTE_INPUT_STATE_TYPING,
                      job->task_id,
                      REMOTE_INPUT_ERR_OK,
                      (uint32_t)job->len,
                      (uint32_t)job->len);

        remote_input_error_t error = write_job(job);
        if (error == REMOTE_INPUT_ERR_OK) {
            notify_status(REMOTE_INPUT_STATE_DONE,
                          job->task_id,
                          REMOTE_INPUT_ERR_OK,
                          (uint32_t)job->len,
                          (uint32_t)job->len);
        } else {
            notify_status(REMOTE_INPUT_STATE_ERROR,
                          job->task_id,
                          error,
                          (uint32_t)job->len,
                          (uint32_t)job->len);
        }

        notify_typing(false);
        set_active(false);
    }
}

esp_err_t remote_input_writer_runner_init(const remote_input_writer_t *writer,
                                          const remote_input_writer_runner_callbacks_t *callbacks)
{
    if (s_initialized) {
        return ESP_OK;
    }
    if (writer == NULL || writer->init == NULL || writer->write_text == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (callbacks != NULL) {
        s_callbacks = *callbacks;
    } else {
        memset(&s_callbacks, 0, sizeof(s_callbacks));
    }

    esp_err_t err = writer->init(writer->ctx);
    if (err != ESP_OK) {
        return err;
    }

    s_queue = xQueueCreate(REMOTE_INPUT_WRITER_QUEUE_LEN, sizeof(writer_job_t *));
    if (s_queue == NULL) {
        return ESP_ERR_NO_MEM;
    }

    BaseType_t worker_created = xTaskCreate(writer_worker_task,
                                            "remote_input_writer",
                                            REMOTE_INPUT_WRITER_STACK_SIZE,
                                            NULL,
                                            REMOTE_INPUT_WRITER_PRIORITY,
                                            NULL);
    if (worker_created != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_writer = writer;
    set_active(false);
    s_initialized = true;
    return ESP_OK;
}

bool remote_input_writer_runner_busy(void)
{
    bool active;

    portENTER_CRITICAL(&s_active_lock);
    active = s_active;
    portEXIT_CRITICAL(&s_active_lock);

    return active;
}

remote_input_error_t remote_input_writer_runner_submit(uint16_t task_id,
                                                       const uint8_t *bytes,
                                                       size_t len)
{
    if (!s_initialized || s_queue == NULL) {
        return REMOTE_INPUT_ERR_DEVICE_BUSY;
    }
    if (len > REMOTE_INPUT_MAX_TEXT_BYTES) {
        return REMOTE_INPUT_ERR_TASK_TOO_LARGE;
    }
    if (bytes == NULL && len > 0) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }
    if (!reserve_writer()) {
        return REMOTE_INPUT_ERR_DEVICE_BUSY;
    }

    s_pending_job.task_id = task_id;
    s_pending_job.len = len;
    if (len > 0) {
        memcpy(s_pending_job.bytes, bytes, len);
    }

    writer_job_t *job = &s_pending_job;
    if (xQueueSend(s_queue, &job, 0) != pdTRUE) {
        set_active(false);
        return REMOTE_INPUT_ERR_DEVICE_BUSY;
    }

    return REMOTE_INPUT_ERR_OK;
}
