#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "relay_frame.h"

int main(void) {
    static const uint8_t check[] = "123456789";
    assert(relay_crc16_ccitt(check, sizeof(check) - 1) == 0x29b1);

    uint8_t report[RELAY_REPORT_BYTES] = {
        0x43, 0x52, 0x02, 0x00,
        0x01, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x01, 0x00,
        0x09, 0x00, 0xb1, 0x29,
        '1', '2', '3', '4', '5', '6', '7', '8', '9',
    };
    uint16_t frame_length = 0;
    assert(relay_frame_validate(report, 25, false, &frame_length));
    assert(frame_length == 25);
    assert(relay_frame_validate(report, sizeof(report), true, &frame_length));
    assert(!relay_frame_validate(report, sizeof(report), false, NULL));

    report[63] = 1;
    assert(!relay_frame_validate(report, sizeof(report), true, NULL));
    report[63] = 0;
    report[16] ^= 1;
    assert(!relay_frame_validate(report, 25, false, NULL));
    report[16] ^= 1;
    report[10] = 0;
    assert(!relay_frame_validate(report, 25, false, NULL));
    report[10] = 1;
    report[12] = 0xff;
    report[13] = 0xff;
    assert(!relay_frame_validate(report, sizeof(report), true, NULL));
    return 0;
}
