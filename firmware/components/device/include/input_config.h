#pragma once

#include <stdint.h>

#include "input_protocol.h"
#include "input_status.h"

void input_config_init(void);
input_config_t input_config_default(void);
input_config_t input_config_get(void);
input_error_t input_config_update(const input_config_frame_t *frame);
