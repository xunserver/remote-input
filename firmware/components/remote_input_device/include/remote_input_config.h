#pragma once

#include <stdint.h>

#include "remote_input_protocol.h"
#include "remote_input_status.h"

void remote_input_config_init(void);
remote_input_config_t remote_input_config_default(void);
remote_input_config_t remote_input_config_get(void);
remote_input_error_t remote_input_config_update(const remote_input_config_frame_t *frame);
