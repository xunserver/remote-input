#pragma once

#include <stdbool.h>
#include <stdint.h>

#define KEYBOARD_REPORT_BYTES 8
#define KEYBOARD_KEY_F13 0x68
#define KEYBOARD_KEY_F14 0x69
#define KEYBOARD_KEY_F15 0x6a
#define KEYBOARD_KEY_F16 0x6b
#define KEYBOARD_KEY_F19 0x6e

/**
 * Encodes one four-bit value as a standard six-key keyboard report.
 * F13 marks protocol traffic, F14/F15 select high/low phase, and F16-F19
 * represent the four data bits.
 */
void keyboard_uplink_encode_nibble(
    uint8_t nibble,
    bool high_phase,
    uint8_t report[KEYBOARD_REPORT_BYTES]
);
