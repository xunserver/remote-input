#include "ai_input_utf8.h"

static bool is_scalar(uint32_t cp)
{
    return cp <= 0x10FFFFu && !(cp >= 0xD800u && cp <= 0xDFFFu);
}

static bool is_continuation(uint8_t byte)
{
    return byte >= 0x80u && byte <= 0xBFu;
}

bool ai_input_utf8_decode_each(const uint8_t *bytes, size_t len, ai_input_codepoint_cb_t cb, void *ctx)
{
    if (cb == NULL) {
        return false;
    }

    if (bytes == NULL && len > 0) {
        return false;
    }

    size_t i = 0;
    while (i < len) {
        const uint8_t b0 = bytes[i];
        uint32_t codepoint = 0;

        if (b0 <= 0x7Fu) {
            codepoint = b0;
            i += 1;
        } else if (b0 >= 0xC2u && b0 <= 0xDFu) {
            if (len - i < 2) {
                return false;
            }

            const uint8_t b1 = bytes[i + 1];
            if (!is_continuation(b1)) {
                return false;
            }

            codepoint = ((uint32_t)(b0 & 0x1Fu) << 6) |
                        (uint32_t)(b1 & 0x3Fu);
            i += 2;
        } else if (b0 >= 0xE0u && b0 <= 0xEFu) {
            if (len - i < 3) {
                return false;
            }

            const uint8_t b1 = bytes[i + 1];
            const uint8_t b2 = bytes[i + 2];
            if (!is_continuation(b1) || !is_continuation(b2)) {
                return false;
            }
            if (b0 == 0xE0u && b1 < 0xA0u) {
                return false;
            }
            if (b0 == 0xEDu && b1 >= 0xA0u) {
                return false;
            }

            codepoint = ((uint32_t)(b0 & 0x0Fu) << 12) |
                        ((uint32_t)(b1 & 0x3Fu) << 6) |
                        (uint32_t)(b2 & 0x3Fu);
            i += 3;
        } else if (b0 >= 0xF0u && b0 <= 0xF4u) {
            if (len - i < 4) {
                return false;
            }

            const uint8_t b1 = bytes[i + 1];
            const uint8_t b2 = bytes[i + 2];
            const uint8_t b3 = bytes[i + 3];
            if (!is_continuation(b1) || !is_continuation(b2) || !is_continuation(b3)) {
                return false;
            }
            if (b0 == 0xF0u && b1 < 0x90u) {
                return false;
            }
            if (b0 == 0xF4u && b1 > 0x8Fu) {
                return false;
            }

            codepoint = ((uint32_t)(b0 & 0x07u) << 18) |
                        ((uint32_t)(b1 & 0x3Fu) << 12) |
                        ((uint32_t)(b2 & 0x3Fu) << 6) |
                        (uint32_t)(b3 & 0x3Fu);
            i += 4;
        } else {
            return false;
        }

        if (!is_scalar(codepoint)) {
            return false;
        }
        if (!cb(codepoint, ctx)) {
            return false;
        }
    }

    return true;
}
