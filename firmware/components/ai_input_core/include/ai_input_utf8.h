#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef bool (*ai_input_codepoint_cb_t)(uint32_t codepoint, void *ctx);

bool ai_input_utf8_decode_each(const uint8_t *bytes, size_t len, ai_input_codepoint_cb_t cb, void *ctx);
