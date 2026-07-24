#pragma once

#include <stdbool.h>
#include <stdint.h>

#define RELAY_HEADER_BYTES 16
#define RELAY_REPORT_BYTES 64
#define RELAY_MAGIC_LOW 0x43
#define RELAY_MAGIC_HIGH 0x52
#define RELAY_VERSION 2

uint16_t relay_crc16_ccitt(const uint8_t *data, uint16_t length);

/** Validates a variable BLE frame or a zero-padded fixed-size HID report. */
bool relay_frame_validate(
    const uint8_t *data,
    uint16_t length,
    bool allow_padding,
    uint16_t *frame_length
);
