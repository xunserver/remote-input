#include "input_writer_runner.h"

#include "input_protocol.h"

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include <stdlib.h>
#include <string.h>

#define INPUT_WRITER_QUEUE_LEN 1
#define INPUT_WRITER_STACK_SIZE 6144
#define INPUT_WRITER_PRIORITY 5

typedef struct {
    uint16_t task_id;
    size_t len;
    input_config_t config;
    uint8_t *bytes;
} writer_job_t;

static const input_writer_t *s_writer;
static input_writer_runner_callbacks_t s_callbacks;
static QueueHandle_t s_queue;
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

static void notify_status(input_state_t state,
                          uint16_t task_id,
                          input_error_t error,
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

static void free_job(writer_job_t *job)
{
    if (job == NULL) {
        return;
    }

    free(job->bytes);
    free(job);
}

static input_error_t write_job(const writer_job_t *job)
{
    if (job == NULL || s_writer == NULL || s_writer->write_text == NULL) {
        return INPUT_ERR_HID_INPUT_FAILED;
    }

    return s_writer->write_text(job->task_id, job->bytes, job->len, &job->config, s_writer->ctx);
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
        notify_status(INPUT_STATE_TYPING,
                      job->task_id,
                      INPUT_ERR_OK,
                      (uint32_t)job->len,
                      (uint32_t)job->len);

        input_error_t error = write_job(job);
        if (error == INPUT_ERR_OK) {
            notify_status(INPUT_STATE_DONE,
                          job->task_id,
                          INPUT_ERR_OK,
                          (uint32_t)job->len,
                          (uint32_t)job->len);
        } else {
            notify_status(INPUT_STATE_ERROR,
                          job->task_id,
                          error,
                          (uint32_t)job->len,
                          (uint32_t)job->len);
        }

        notify_typing(false);
        free_job(job);
        set_active(false);
    }
}

esp_err_t input_writer_runner_init(const input_writer_t *writer,
                                          const input_writer_runner_callbacks_t *callbacks)
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

    s_queue = xQueueCreate(INPUT_WRITER_QUEUE_LEN, sizeof(writer_job_t *));
    if (s_queue == NULL) {
        return ESP_ERR_NO_MEM;
    }

    BaseType_t worker_created = xTaskCreate(writer_worker_task,
                                            "input_writer",
                                            INPUT_WRITER_STACK_SIZE,
                                            NULL,
                                            INPUT_WRITER_PRIORITY,
                                            NULL);
    if (worker_created != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_writer = writer;
    set_active(false);
    s_initialized = true;
    return ESP_OK;
}

bool input_writer_runner_busy(void)
{
    bool active;

    portENTER_CRITICAL(&s_active_lock);
    active = s_active;
    portEXIT_CRITICAL(&s_active_lock);

    return active;
}

input_error_t input_writer_runner_submit(uint16_t task_id,
                                                       const uint8_t *bytes,
                                                       size_t len,
                                                       input_config_t config)
{
    if (!s_initialized || s_queue == NULL) {
        return INPUT_ERR_DEVICE_BUSY;
    }
    if (len > INPUT_MAX_TEXT_BYTES) {
        return INPUT_ERR_TASK_TOO_LARGE;
    }
    if (bytes == NULL && len > 0) {
        return INPUT_ERR_INVALID_COMMAND;
    }
    if (config.key_delay_ms < INPUT_KEY_DELAY_MIN_MS ||
        config.key_delay_ms > INPUT_KEY_DELAY_MAX_MS) {
        return INPUT_ERR_INVALID_COMMAND;
    }
    if (!reserve_writer()) {
        return INPUT_ERR_DEVICE_BUSY;
    }

    writer_job_t *job = (writer_job_t *)calloc(1, sizeof(writer_job_t));
    if (job == NULL) {
        set_active(false);
        return INPUT_ERR_TASK_TOO_LARGE;
    }

    job->task_id = task_id;
    job->len = len;
    job->config = config;

    if (len > 0) {
        job->bytes = (uint8_t *)malloc(len);
        if (job->bytes == NULL) {
            free_job(job);
            set_active(false);
            return INPUT_ERR_TASK_TOO_LARGE;
        }
        memcpy(job->bytes, bytes, len);
    }

    if (xQueueSend(s_queue, &job, 0) != pdTRUE) {
        free_job(job);
        set_active(false);
        return INPUT_ERR_DEVICE_BUSY;
    }

    return INPUT_ERR_OK;
}
