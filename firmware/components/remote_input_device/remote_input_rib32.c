#include "remote_input_rib32.h"

#include <stdio.h>
#include <string.h>

#define RIB32_MAX_BASE32_CHARS (((REMOTE_INPUT_RIB32_CHUNK_BYTES * 8) + 4) / 5)
#define RIB32_MAX_LINE_CHARS 128

static const char s_base32_alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

static uint32_t crc32_bytes(const uint8_t *bytes, size_t len)
{
    uint32_t crc = 0xFFFFFFFFu;

    for (size_t i = 0; i < len; ++i) {
        crc ^= bytes[i];
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1) ^ ((crc & 1u) ? 0xEDB88320u : 0u);
        }
    }

    return crc ^ 0xFFFFFFFFu;
}

static size_t base32_encode(const uint8_t *bytes, size_t len, char *out, size_t out_len)
{
    uint32_t buffer = 0;
    int bits = 0;
    size_t written = 0;

    for (size_t i = 0; i < len; ++i) {
        buffer = (buffer << 8) | bytes[i];
        bits += 8;
        while (bits >= 5) {
            if (written + 1 >= out_len) {
                return 0;
            }
            out[written++] = s_base32_alphabet[(buffer >> (bits - 5)) & 31u];
            bits -= 5;
        }
    }

    if (bits > 0) {
        if (written + 1 >= out_len) {
            return 0;
        }
        out[written++] = s_base32_alphabet[(buffer << (5 - bits)) & 31u];
    }

    out[written] = '\0';
    return written;
}

esp_err_t remote_input_rib32_emit(uint16_t task_id,
                                  const uint8_t *bytes,
                                  size_t len,
                                  remote_input_rib32_line_cb_t cb,
                                  void *ctx)
{
    if ((bytes == NULL && len > 0) || cb == NULL || task_id == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    const size_t total_chunks = len == 0 ? 1 : (len + REMOTE_INPUT_RIB32_CHUNK_BYTES - 1) / REMOTE_INPUT_RIB32_CHUNK_BYTES;
    if (total_chunks > UINT16_MAX) {
        return ESP_ERR_INVALID_SIZE;
    }

    for (size_t index = 0; index < total_chunks; ++index) {
        const size_t offset = index * REMOTE_INPUT_RIB32_CHUNK_BYTES;
        const size_t remaining = len > offset ? len - offset : 0;
        const size_t chunk_len = remaining > REMOTE_INPUT_RIB32_CHUNK_BYTES ? REMOTE_INPUT_RIB32_CHUNK_BYTES : remaining;
        const uint8_t *chunk = chunk_len > 0 ? bytes + offset : NULL;
        char payload[RIB32_MAX_BASE32_CHARS + 1] = {0};
        char line[RIB32_MAX_LINE_CHARS] = {0};

        if (base32_encode(chunk, chunk_len, payload, sizeof(payload)) == 0 && chunk_len > 0) {
            return ESP_ERR_INVALID_SIZE;
        }

        int written = snprintf(line,
                               sizeof(line),
                               "<RIB32:%d:%u:%u:%u:%08lX:%s>",
                               REMOTE_INPUT_RIB32_VERSION,
                               (unsigned)task_id,
                               (unsigned)index,
                               (unsigned)total_chunks,
                               (unsigned long)crc32_bytes(chunk, chunk_len),
                               payload);
        if (written <= 0 || written >= (int)sizeof(line)) {
            return ESP_ERR_INVALID_SIZE;
        }

        esp_err_t err = cb(line, ctx);
        if (err != ESP_OK) {
            return err;
        }
    }

    char end_line[RIB32_MAX_LINE_CHARS] = {0};
    int written = snprintf(end_line,
                           sizeof(end_line),
                           "</RIB32:%d:%u:%08lX>",
                           REMOTE_INPUT_RIB32_VERSION,
                           (unsigned)task_id,
                           (unsigned long)crc32_bytes(bytes, len));
    if (written <= 0 || written >= (int)sizeof(end_line)) {
        return ESP_ERR_INVALID_SIZE;
    }

    return cb(end_line, ctx);
}
