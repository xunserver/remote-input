#include <assert.h>
#include <stdbool.h>
#include <stdint.h>

#include "keyboard_uplink.h"

static bool contains(const uint8_t report[KEYBOARD_REPORT_BYTES], uint8_t key) {
    for (uint8_t index = 2; index < KEYBOARD_REPORT_BYTES; ++index) {
        if (report[index] == key) return true;
    }
    return false;
}

static uint8_t decode_nibble(const uint8_t report[KEYBOARD_REPORT_BYTES]) {
    uint8_t nibble = 0;
    for (uint8_t bit = 0; bit < 4; ++bit) {
        if (contains(report, KEYBOARD_KEY_F16 + bit)) {
            nibble |= 1u << (3u - bit);
        }
    }
    return nibble;
}

int main(void) {
    for (uint8_t nibble = 0; nibble < 16; ++nibble) {
        for (uint8_t phase = 0; phase < 2; ++phase) {
            uint8_t report[KEYBOARD_REPORT_BYTES];
            keyboard_uplink_encode_nibble(nibble, phase != 0, report);

            assert(report[0] == 0);
            assert(report[1] == 0);
            assert(contains(report, KEYBOARD_KEY_F13));
            assert(contains(report, phase != 0 ? KEYBOARD_KEY_F14 : KEYBOARD_KEY_F15));
            assert(!contains(report, phase != 0 ? KEYBOARD_KEY_F15 : KEYBOARD_KEY_F14));
            assert(decode_nibble(report) == nibble);

            for (uint8_t index = 2; index < KEYBOARD_REPORT_BYTES; ++index) {
                uint8_t key = report[index];
                assert(key == 0 || (key >= KEYBOARD_KEY_F13 && key <= KEYBOARD_KEY_F19));
                for (uint8_t prior = 2; key != 0 && prior < index; ++prior) {
                    assert(report[prior] != key);
                }
            }
        }
    }
    return 0;
}
