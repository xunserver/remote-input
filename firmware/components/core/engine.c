#include "input_engine.h"

#include <string.h>

static void notify_status(input_engine_t *engine,
                          input_state_t state,
                          uint16_t task_id,
                          input_error_t error,
                          uint32_t received,
                          uint32_t total)
{
    if (engine != NULL && engine->callbacks.on_status != NULL) {
        engine->callbacks.on_status(state, task_id, error, received, total, engine->callbacks.ctx);
    }
}

static bool output_busy(const input_engine_t *engine)
{
    if (engine == NULL || engine->callbacks.output_busy == NULL) {
        return false;
    }

    return engine->callbacks.output_busy(engine->callbacks.ctx);
}

static input_error_t submit_text(input_engine_t *engine,
                                        uint16_t task_id,
                                        const uint8_t *bytes,
                                        size_t len,
                                        input_config_t config)
{
    if (engine == NULL || engine->callbacks.submit_text == NULL) {
        return INPUT_ERR_DEVICE_BUSY;
    }

    return engine->callbacks.submit_text(task_id, bytes, len, config, engine->callbacks.ctx);
}

static input_error_t capture_config(input_engine_t *engine,
                                           input_config_t *config)
{
    if (engine == NULL || config == NULL) {
        return INPUT_ERR_INVALID_COMMAND;
    }

    *config = (input_config_t) {
        .key_delay_ms = INPUT_KEY_DELAY_DEFAULT_MS,
    };
    if (engine->callbacks.capture_config == NULL) {
        return INPUT_ERR_OK;
    }

    return engine->callbacks.capture_config(config, engine->callbacks.ctx);
}

static input_error_t apply_config(input_engine_t *engine,
                                         const input_config_frame_t *frame)
{
    if (engine == NULL || engine->callbacks.apply_config == NULL) {
        return INPUT_ERR_INVALID_COMMAND;
    }

    return engine->callbacks.apply_config(frame, engine->callbacks.ctx);
}

void input_engine_init(input_engine_t *engine,
                              const input_engine_callbacks_t *callbacks)
{
    if (engine == NULL) {
        return;
    }

    memset(engine, 0, sizeof(*engine));
    input_task_init(&engine->task);
    if (callbacks != NULL) {
        engine->callbacks = *callbacks;
    }
}

void input_engine_handle_control(input_engine_t *engine,
                                        const input_control_frame_t *frame)
{
    if (engine == NULL || frame == NULL) {
        notify_status(engine, INPUT_STATE_ERROR, 0, INPUT_ERR_INVALID_COMMAND, 0, 0);
        return;
    }

    if (frame->type == INPUT_CONTROL_START) {
        if (output_busy(engine)) {
            notify_status(engine,
                          INPUT_STATE_ERROR,
                          frame->task_id,
                          INPUT_ERR_DEVICE_BUSY,
                          0,
                          frame->total_bytes);
            return;
        }

        input_engine_reset_receive(engine);
        input_error_t err = input_task_start(&engine->task, frame);
        if (err == INPUT_ERR_OK) {
            err = capture_config(engine, &engine->task.config);
            if (err != INPUT_ERR_OK) {
                input_engine_reset_receive(engine);
            }
        }
        if (err == INPUT_ERR_OK) {
            notify_status(engine,
                          INPUT_STATE_RECEIVING,
                          frame->task_id,
                          INPUT_ERR_OK,
                          0,
                          frame->total_bytes);
        } else {
            notify_status(engine,
                          INPUT_STATE_ERROR,
                          frame->task_id,
                          err,
                          0,
                          frame->total_bytes);
        }
        return;
    }

    if (frame->type == INPUT_CONTROL_COMMIT) {
        const uint8_t *bytes = NULL;
        size_t len = 0;
        input_error_t err = input_task_commit(&engine->task, frame, &bytes, &len);
        uint32_t received = engine->task.received_bytes;
        uint32_t total = engine->task.total_bytes;
        if (err != INPUT_ERR_OK) {
            notify_status(engine,
                          INPUT_STATE_ERROR,
                          frame->task_id,
                          err,
                          received,
                          frame->total_bytes);
            input_engine_reset_receive(engine);
            return;
        }

        err = submit_text(engine, frame->task_id, bytes, len, engine->task.config);
        if (err != INPUT_ERR_OK) {
            notify_status(engine,
                          INPUT_STATE_ERROR,
                          frame->task_id,
                          err,
                          received,
                          total);
        }
        input_engine_reset_receive(engine);
        return;
    }

    notify_status(engine,
                  INPUT_STATE_ERROR,
                  frame->task_id,
                  INPUT_ERR_INVALID_COMMAND,
                  0,
                  frame->total_bytes);
}

void input_engine_handle_config(input_engine_t *engine,
                                       const input_config_frame_t *frame)
{
    if (engine == NULL || frame == NULL) {
        notify_status(engine, INPUT_STATE_ERROR, 0, INPUT_ERR_INVALID_COMMAND, 0, 0);
        return;
    }

    input_error_t err = apply_config(engine, frame);
    if (err != INPUT_ERR_OK) {
        notify_status(engine, INPUT_STATE_ERROR, 0, err, 0, 0);
    }
}

void input_engine_handle_data(input_engine_t *engine,
                                     const input_data_frame_t *frame)
{
    if (engine == NULL || frame == NULL) {
        notify_status(engine, INPUT_STATE_ERROR, 0, INPUT_ERR_INVALID_CHUNK, 0, 0);
        return;
    }

    input_error_t err = input_task_add_chunk(&engine->task, frame);
    if (err == INPUT_ERR_OK) {
        notify_status(engine,
                      INPUT_STATE_RECEIVING,
                      frame->task_id,
                      INPUT_ERR_OK,
                      engine->task.received_bytes,
                      engine->task.total_bytes);
        return;
    }

    uint32_t received = engine->task.received_bytes;
    uint32_t total = engine->task.total_bytes;
    notify_status(engine, INPUT_STATE_ERROR, frame->task_id, err, received, total);
    input_engine_reset_receive(engine);
}

void input_engine_handle_receiver_error(input_engine_t *engine,
                                               input_error_t error)
{
    notify_status(engine, INPUT_STATE_ERROR, 0, error, 0, 0);
}

void input_engine_reset_receive(input_engine_t *engine)
{
    if (engine == NULL) {
        return;
    }

    if (engine->task.active) {
        input_task_reset(&engine->task);
    }
}
