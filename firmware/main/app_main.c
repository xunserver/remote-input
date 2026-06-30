#include "ai_input_ble.h"
#include "ai_input_hid.h"
#include "ai_input_status.h"
#include "ai_input_task.h"
#include "ai_input_utf8.h"

#include "esp_err.h"
#include "esp_log.h"

static const char *TAG = "ai_input";
static ai_input_task_buffer_t g_task;
static const uint8_t *g_pending_bytes = NULL;
static size_t g_pending_len = 0;

typedef struct {
    ai_input_error_t error;
} typing_context_t;

static bool type_codepoint_cb(uint32_t codepoint, void *ctx)
{
    typing_context_t *typing_ctx = (typing_context_t *)ctx;
    esp_err_t err = ai_input_hid_type_codepoint(codepoint);
    if (err != ESP_OK) {
        if (typing_ctx != NULL) {
            typing_ctx->error = AI_INPUT_ERR_HID_INPUT_FAILED;
        }
        return false;
    }

    return true;
}

static void run_typing_task(uint16_t task_id, const uint8_t *bytes, size_t len)
{
    ai_input_status_set(AI_INPUT_STATE_TYPING, task_id, AI_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);
    ai_input_ble_notify_status();

    if (!ai_input_hid_ready()) {
        ai_input_status_set(AI_INPUT_STATE_ERROR, task_id, AI_INPUT_ERR_USB_NOT_READY, (uint32_t)len, (uint32_t)len);
        ai_input_ble_notify_status();
        ai_input_task_reset(&g_task);
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
        ai_input_task_reset(&g_task);
        return;
    }

    ai_input_status_set(AI_INPUT_STATE_DONE, task_id, AI_INPUT_ERR_OK, (uint32_t)len, (uint32_t)len);
    ai_input_ble_notify_status();
    ai_input_task_reset(&g_task);
}

static void on_control(const ai_input_control_frame_t *frame)
{
    ai_input_error_t err = AI_INPUT_ERR_OK;

    if (frame->type == AI_INPUT_CONTROL_START) {
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
            ai_input_task_reset(&g_task);
            return;
        }
        run_typing_task(frame->task_id, g_pending_bytes, g_pending_len);
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
    } else {
        ai_input_status_set(AI_INPUT_STATE_ERROR, frame->task_id, err, g_task.received_bytes, g_task.total_bytes);
    }
    ai_input_ble_notify_status();
}

void app_main(void)
{
    ESP_LOGI(TAG, "AI Input firmware booting");

    ai_input_status_init();
    ai_input_task_init(&g_task);
    ESP_ERROR_CHECK(ai_input_hid_init());

    const ai_input_ble_callbacks_t callbacks = {
        .on_control = on_control,
        .on_data = on_data,
    };
    ESP_ERROR_CHECK(ai_input_ble_init(&callbacks));

    ESP_LOGI(TAG, "AI Input ready");
}
