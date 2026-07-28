#include "keyboard_uplink.h"

#include <string.h>

void keyboard_uplink_encode_nibble(
    uint8_t nibble,
    bool high_phase,
    uint8_t report[KEYBOARD_REPORT_BYTES]
) {
    memset(report, 0, KEYBOARD_REPORT_BYTES);
    report[2] = KEYBOARD_KEY_F13;
    report[3] = high_phase ? KEYBOARD_KEY_F14 : KEYBOARD_KEY_F15;
    uint8_t position = 4;
    for (uint8_t bit = 0; bit < 4; ++bit) {
        if ((nibble & (1u << (3u - bit))) != 0) {
            report[position++] = KEYBOARD_KEY_F16 + bit;
        }
    }
}
