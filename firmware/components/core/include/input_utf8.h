#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef bool (*input_codepoint_cb_t)(uint32_t codepoint, void *ctx);

bool input_utf8_decode_each(const uint8_t *bytes, size_t len, input_codepoint_cb_t cb, void *ctx);
