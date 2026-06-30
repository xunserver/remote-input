#include "ai_input_hid.h"

#include <stdio.h>

#include "class/hid/hid_device.h"
#include "esp_check.h"
#include "esp_log.h"
#include "tinyusb.h"
#include "tinyusb_default_config.h"
#include "tusb.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ai_input_hid";
static const uint8_t REPORT_ID_KEYBOARD = 1;

enum {
    REPORT_ID_KEYBOARD_DESCRIPTOR = 1,
    HID_RELEASE_RETRY_COUNT = 10,
    TUSB_DESC_TOTAL_LEN = TUD_CONFIG_DESC_LEN + TUD_HID_DESC_LEN,
};

static const uint8_t s_hid_report_descriptor[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(REPORT_ID_KEYBOARD_DESCRIPTOR)),
};

static const char *s_hid_string_descriptor[] = {
    (char[]){0x09, 0x04},
    "AI Input",
    "AI Input HID Keyboard",
    "000001",
    "HID Keyboard",
};

static const uint8_t s_hid_configuration_descriptor[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, TUSB_DESC_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_HID_DESCRIPTOR(0, 4, false, sizeof(s_hid_report_descriptor), 0x81, 16, 10),
};

esp_err_t ai_input_hid_init(void)
{
    tinyusb_config_t tusb_cfg = TINYUSB_DEFAULT_CONFIG();
    tusb_cfg.descriptor.device = NULL;
    tusb_cfg.descriptor.full_speed_config = s_hid_configuration_descriptor;
    tusb_cfg.descriptor.string = s_hid_string_descriptor;
    tusb_cfg.descriptor.string_count = sizeof(s_hid_string_descriptor) / sizeof(s_hid_string_descriptor[0]);
#if (TUD_OPT_HIGH_SPEED)
    tusb_cfg.descriptor.high_speed_config = s_hid_configuration_descriptor;
#endif

    ESP_RETURN_ON_ERROR(tinyusb_driver_install(&tusb_cfg), TAG, "tinyusb install failed");
    return ESP_OK;
}

bool ai_input_hid_ready(void)
{
    return tud_mounted();
}

static uint8_t hex_keycode(char c)
{
    static const uint8_t digit_keycodes[] = {
        HID_KEY_0,
        HID_KEY_1,
        HID_KEY_2,
        HID_KEY_3,
        HID_KEY_4,
        HID_KEY_5,
        HID_KEY_6,
        HID_KEY_7,
        HID_KEY_8,
        HID_KEY_9,
    };

    if (c >= '0' && c <= '9') {
        return digit_keycodes[(uint8_t)(c - '0')];
    }
    if (c >= 'A' && c <= 'F') {
        return HID_KEY_A + (uint8_t)(c - 'A');
    }
    return 0;
}

static esp_err_t send_report(uint8_t modifier, uint8_t const keycode[6])
{
    if (!tud_hid_ready()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!tud_hid_keyboard_report(REPORT_ID_KEYBOARD, modifier, keycode)) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    vTaskDelay(pdMS_TO_TICKS(AI_INPUT_HID_DELAY_MS));
    return ESP_OK;
}

static esp_err_t release_all_keys(void)
{
    const uint8_t keys[6] = {0};

    for (int attempt = 0; attempt < HID_RELEASE_RETRY_COUNT; ++attempt) {
        if (!tud_mounted()) {
            return ESP_ERR_INVALID_STATE;
        }
        if (tud_hid_ready()) {
            if (!tud_hid_keyboard_report(REPORT_ID_KEYBOARD, 0, keys)) {
                return ESP_ERR_INVALID_RESPONSE;
            }
            vTaskDelay(pdMS_TO_TICKS(AI_INPUT_HID_DELAY_MS));
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(AI_INPUT_HID_DELAY_MS));
    }

    return ESP_ERR_TIMEOUT;
}

static esp_err_t send_alt_modified_key(uint8_t keycode)
{
    const uint8_t keys[6] = {keycode, 0, 0, 0, 0, 0};
    const uint8_t no_keys[6] = {0};

    ESP_RETURN_ON_ERROR(send_report(KEYBOARD_MODIFIER_LEFTALT, keys), TAG, "hid key press failed");
    ESP_RETURN_ON_ERROR(send_report(KEYBOARD_MODIFIER_LEFTALT, no_keys), TAG, "hid key release failed");
    return ESP_OK;
}

esp_err_t ai_input_hid_type_codepoint(uint32_t codepoint)
{
    if (!ai_input_hid_ready()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (codepoint > 0x10FFFFu || (codepoint >= 0xD800u && codepoint <= 0xDFFFu)) {
        return ESP_ERR_INVALID_ARG;
    }

    char hex[9] = {0};
    int written = snprintf(hex, sizeof(hex), "%lX", (unsigned long)codepoint);
    if (written <= 0 || written >= (int)sizeof(hex)) {
        return ESP_ERR_INVALID_RESPONSE;
    }

    const uint8_t no_keys[6] = {0};
    esp_err_t ret = send_report(KEYBOARD_MODIFIER_LEFTALT, no_keys);
    if (ret != ESP_OK) {
        (void)release_all_keys();
        return ret;
    }

    ret = send_alt_modified_key(HID_KEY_KEYPAD_ADD);
    if (ret != ESP_OK) {
        (void)release_all_keys();
        return ret;
    }

    for (const char *p = hex; *p != '\0'; ++p) {
        uint8_t keycode = hex_keycode(*p);
        if (keycode == 0) {
            (void)release_all_keys();
            return ESP_ERR_INVALID_ARG;
        }

        ret = send_alt_modified_key(keycode);
        if (ret != ESP_OK) {
            (void)release_all_keys();
            return ret;
        }
    }

    return release_all_keys();
}

uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance)
{
    (void)instance;
    return s_hid_report_descriptor;
}

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type, uint8_t *buffer, uint16_t reqlen)
{
    (void)instance;
    (void)report_id;
    (void)report_type;
    (void)buffer;
    (void)reqlen;
    return 0;
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type, uint8_t const *buffer, uint16_t bufsize)
{
    (void)instance;
    (void)report_id;
    (void)report_type;
    (void)buffer;
    (void)bufsize;
}
