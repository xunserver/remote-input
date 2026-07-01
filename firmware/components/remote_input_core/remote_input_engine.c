#include "remote_input_engine.h"

#include <string.h>

static void notify_status(remote_input_engine_t *engine,
                          remote_input_state_t state,
                          uint16_t task_id,
                          remote_input_error_t error,
                          uint32_t received,
                          uint32_t total)
{
    if (engine != NULL && engine->callbacks.on_status != NULL) {
        engine->callbacks.on_status(state, task_id, error, received, total, engine->callbacks.ctx);
    }
}

static bool output_busy(const remote_input_engine_t *engine)
{
    if (engine == NULL || engine->callbacks.output_busy == NULL) {
        return false;
    }

    return engine->callbacks.output_busy(engine->callbacks.ctx);
}

static remote_input_error_t submit_text(remote_input_engine_t *engine,
                                        uint16_t task_id,
                                        const uint8_t *bytes,
                                        size_t len,
                                        remote_input_config_t config)
{
    if (engine == NULL || engine->callbacks.submit_text == NULL) {
        return REMOTE_INPUT_ERR_DEVICE_BUSY;
    }

    return engine->callbacks.submit_text(task_id, bytes, len, config, engine->callbacks.ctx);
}

static remote_input_error_t capture_config(remote_input_engine_t *engine,
                                           remote_input_config_t *config)
{
    if (engine == NULL || config == NULL) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }

    *config = (remote_input_config_t) {
        .key_delay_ms = REMOTE_INPUT_KEY_DELAY_DEFAULT_MS,
    };
    if (engine->callbacks.capture_config == NULL) {
        return REMOTE_INPUT_ERR_OK;
    }

    return engine->callbacks.capture_config(config, engine->callbacks.ctx);
}

static remote_input_error_t apply_config(remote_input_engine_t *engine,
                                         const remote_input_config_frame_t *frame)
{
    if (engine == NULL || engine->callbacks.apply_config == NULL) {
        return REMOTE_INPUT_ERR_INVALID_COMMAND;
    }

    return engine->callbacks.apply_config(frame, engine->callbacks.ctx);
}

void remote_input_engine_init(remote_input_engine_t *engine,
                              const remote_input_engine_callbacks_t *callbacks)
{
    if (engine == NULL) {
        return;
    }

    memset(engine, 0, sizeof(*engine));
    remote_input_task_init(&engine->task);
    if (callbacks != NULL) {
        engine->callbacks = *callbacks;
    }
}

void remote_input_engine_handle_control(remote_input_engine_t *engine,
                                        const remote_input_control_frame_t *frame)
{
    if (engine == NULL || frame == NULL) {
        notify_status(engine, REMOTE_INPUT_STATE_ERROR, 0, REMOTE_INPUT_ERR_INVALID_COMMAND, 0, 0);
        return;
    }

    if (frame->type == REMOTE_INPUT_CONTROL_START) {
        if (output_busy(engine)) {
            notify_status(engine,
                          REMOTE_INPUT_STATE_ERROR,
                          frame->task_id,
                          REMOTE_INPUT_ERR_DEVICE_BUSY,
                          0,
                          frame->total_bytes);
            return;
        }

        remote_input_engine_reset_receive(engine);
        remote_input_error_t err = remote_input_task_start(&engine->task, frame);
        if (err == REMOTE_INPUT_ERR_OK) {
            err = capture_config(engine, &engine->task.config);
            if (err != REMOTE_INPUT_ERR_OK) {
                remote_input_engine_reset_receive(engine);
            }
        }
        if (err == REMOTE_INPUT_ERR_OK) {
            notify_status(engine,
                          REMOTE_INPUT_STATE_RECEIVING,
                          frame->task_id,
                          REMOTE_INPUT_ERR_OK,
                          0,
                          frame->total_bytes);
        } else {
            notify_status(engine,
                          REMOTE_INPUT_STATE_ERROR,
                          frame->task_id,
                          err,
                          0,
                          frame->total_bytes);
        }
        return;
    }

    if (frame->type == REMOTE_INPUT_CONTROL_COMMIT) {
        const uint8_t *bytes = NULL;
        size_t len = 0;
        remote_input_error_t err = remote_input_task_commit(&engine->task, frame, &bytes, &len);
        uint32_t received = engine->task.received_bytes;
        uint32_t total = engine->task.total_bytes;
        if (err != REMOTE_INPUT_ERR_OK) {
            notify_status(engine,
                          REMOTE_INPUT_STATE_ERROR,
                          frame->task_id,
                          err,
                          received,
                          frame->total_bytes);
            remote_input_engine_reset_receive(engine);
            return;
        }

        err = submit_text(engine, frame->task_id, bytes, len, engine->task.config);
        if (err != REMOTE_INPUT_ERR_OK) {
            notify_status(engine,
                          REMOTE_INPUT_STATE_ERROR,
                          frame->task_id,
                          err,
                          received,
                          total);
        }
        remote_input_engine_reset_receive(engine);
        return;
    }

    notify_status(engine,
                  REMOTE_INPUT_STATE_ERROR,
                  frame->task_id,
                  REMOTE_INPUT_ERR_INVALID_COMMAND,
                  0,
                  frame->total_bytes);
}

void remote_input_engine_handle_config(remote_input_engine_t *engine,
                                       const remote_input_config_frame_t *frame)
{
    if (engine == NULL || frame == NULL) {
        notify_status(engine, REMOTE_INPUT_STATE_ERROR, 0, REMOTE_INPUT_ERR_INVALID_COMMAND, 0, 0);
        return;
    }

    remote_input_error_t err = apply_config(engine, frame);
    if (err != REMOTE_INPUT_ERR_OK) {
        notify_status(engine, REMOTE_INPUT_STATE_ERROR, 0, err, 0, 0);
    }
}

void remote_input_engine_handle_data(remote_input_engine_t *engine,
                                     const remote_input_data_frame_t *frame)
{
    if (engine == NULL || frame == NULL) {
        notify_status(engine, REMOTE_INPUT_STATE_ERROR, 0, REMOTE_INPUT_ERR_INVALID_CHUNK, 0, 0);
        return;
    }

    remote_input_error_t err = remote_input_task_add_chunk(&engine->task, frame);
    if (err == REMOTE_INPUT_ERR_OK) {
        notify_status(engine,
                      REMOTE_INPUT_STATE_RECEIVING,
                      frame->task_id,
                      REMOTE_INPUT_ERR_OK,
                      engine->task.received_bytes,
                      engine->task.total_bytes);
        return;
    }

    uint32_t received = engine->task.received_bytes;
    uint32_t total = engine->task.total_bytes;
    notify_status(engine, REMOTE_INPUT_STATE_ERROR, frame->task_id, err, received, total);
    remote_input_engine_reset_receive(engine);
}

void remote_input_engine_handle_receiver_error(remote_input_engine_t *engine,
                                               remote_input_error_t error)
{
    notify_status(engine, REMOTE_INPUT_STATE_ERROR, 0, error, 0, 0);
}

void remote_input_engine_reset_receive(remote_input_engine_t *engine)
{
    if (engine == NULL) {
        return;
    }

    if (engine->task.active) {
        remote_input_task_reset(&engine->task);
    }
}
