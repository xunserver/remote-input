#include "input_hid.h"

#include <stddef.h>

#include "class/hid/hid_device.h"
#include "esp_check.h"
#include "esp_log.h"
#include "input_rib32.h"
#include "input_utf8.h"
#include "tinyusb.h"
#include "tinyusb_default_config.h"
#include "tusb.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "input_hid";
static const uint8_t REPORT_ID_KEYBOARD = 1;

typedef struct {
    input_error_t error;
    uint16_t key_delay_ms;
} hid_write_context_t;

static bool validate_codepoint_cb(uint32_t codepoint, void *ctx)
{
    (void)codepoint;
    (void)ctx;
    return true;
}

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
    "Input",
    "Input HID Keyboard",
    "000001",
    "HID Keyboard",
};

static const uint8_t s_hid_configuration_descriptor[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, TUSB_DESC_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_HID_DESCRIPTOR(0, 4, false, sizeof(s_hid_report_descriptor), 0x81, 16, 10),
};

esp_err_t input_hid_init(void)
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

bool input_hid_ready(void)
{
    return tud_mounted();
}

static esp_err_t send_report(uint8_t modifier, uint8_t const keycode[6], uint16_t key_delay_ms)
{
    if (!tud_hid_ready()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!tud_hid_keyboard_report(REPORT_ID_KEYBOARD, modifier, keycode)) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    vTaskDelay(pdMS_TO_TICKS(key_delay_ms));
    return ESP_OK;
}

static esp_err_t release_all_keys(uint16_t key_delay_ms)
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
            vTaskDelay(pdMS_TO_TICKS(key_delay_ms));
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(key_delay_ms));
    }

    return ESP_ERR_TIMEOUT;
}

typedef struct {
    uint8_t modifier;
    uint8_t keycode;
} ascii_key_t;

static bool ascii_key_for_char(char ch, ascii_key_t *out)
{
    if (out == NULL) {
        return false;
    }

    if (ch >= 'A' && ch <= 'Z') {
        out->modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
        out->keycode = HID_KEY_A + (uint8_t)(ch - 'A');
        return true;
    }
    if (ch >= 'a' && ch <= 'z') {
        out->modifier = 0;
        out->keycode = HID_KEY_A + (uint8_t)(ch - 'a');
        return true;
    }
    if (ch >= '1' && ch <= '9') {
        out->modifier = 0;
        out->keycode = HID_KEY_1 + (uint8_t)(ch - '1');
        return true;
    }
    if (ch == '0') {
        out->modifier = 0;
        out->keycode = HID_KEY_0;
        return true;
    }

    switch (ch) {
    case '<':
        out->modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
        out->keycode = HID_KEY_COMMA;
        return true;
    case '>':
        out->modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
        out->keycode = HID_KEY_PERIOD;
        return true;
    case '/':
        out->modifier = 0;
        out->keycode = HID_KEY_SLASH;
        return true;
    case ':':
        out->modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
        out->keycode = HID_KEY_SEMICOLON;
        return true;
    default:
        return false;
    }
}

static esp_err_t send_key(uint8_t modifier, uint8_t keycode, uint16_t key_delay_ms)
{
    const uint8_t keys[6] = {keycode, 0, 0, 0, 0, 0};
    const uint8_t no_keys[6] = {0};

    ESP_RETURN_ON_ERROR(send_report(modifier, keys, key_delay_ms), TAG, "hid key press failed");
    ESP_RETURN_ON_ERROR(send_report(0, no_keys, key_delay_ms), TAG, "hid key release failed");
    return ESP_OK;
}

static esp_err_t type_ascii_char(char ch, uint16_t key_delay_ms)
{
    ascii_key_t key = {0};
    if (!ascii_key_for_char(ch, &key)) {
        return ESP_ERR_INVALID_ARG;
    }
    return send_key(key.modifier, key.keycode, key_delay_ms);
}

static esp_err_t type_enter(uint16_t key_delay_ms)
{
    return send_key(0, HID_KEY_ENTER, key_delay_ms);
}

static esp_err_t type_rib32_line_cb(const char *line, void *ctx)
{
    hid_write_context_t *write_ctx = (hid_write_context_t *)ctx;
    if (line == NULL || write_ctx == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    for (const char *p = line; *p != '\0'; ++p) {
        esp_err_t err = type_ascii_char(*p, write_ctx->key_delay_ms);
        if (err != ESP_OK) {
            (void)release_all_keys(write_ctx->key_delay_ms);
            write_ctx->error = (err == ESP_ERR_INVALID_STATE) ? INPUT_ERR_USB_NOT_READY
                                                              : INPUT_ERR_HID_INPUT_FAILED;
            return err;
        }
    }

    esp_err_t err = type_enter(write_ctx->key_delay_ms);
    if (err != ESP_OK) {
        (void)release_all_keys(write_ctx->key_delay_ms);
        write_ctx->error = (err == ESP_ERR_INVALID_STATE) ? INPUT_ERR_USB_NOT_READY
                                                          : INPUT_ERR_HID_INPUT_FAILED;
        return err;
    }

    return ESP_OK;
}

static esp_err_t hid_writer_init(void *ctx)
{
    (void)ctx;
    return input_hid_init();
}

static bool hid_writer_ready(void *ctx)
{
    (void)ctx;
    return input_hid_ready();
}

input_error_t input_hid_write_text(uint16_t task_id,
                                                 const uint8_t *bytes,
                                                 size_t len,
                                                 const input_config_t *config,
                                                 void *ctx)
{
    (void)ctx;
    const uint16_t key_delay_ms = config != NULL ? config->key_delay_ms : INPUT_KEY_DELAY_DEFAULT_MS;

    if (bytes == NULL && len > 0) {
        return INPUT_ERR_INVALID_COMMAND;
    }
    if (key_delay_ms < INPUT_KEY_DELAY_MIN_MS || key_delay_ms > INPUT_KEY_DELAY_MAX_MS) {
        return INPUT_ERR_INVALID_COMMAND;
    }

    if (!input_utf8_decode_each(bytes, len, validate_codepoint_cb, NULL)) {
        return INPUT_ERR_INVALID_UTF8;
    }
    if (task_id == 0) {
        // RIB32 输出帧不接受 task id 0。
        return INPUT_ERR_INVALID_COMMAND;
    }

    if (!input_hid_ready()) {
        return INPUT_ERR_USB_NOT_READY;
    }

    hid_write_context_t write_ctx = {
        .error = INPUT_ERR_OK,
        .key_delay_ms = key_delay_ms,
    };

    esp_err_t err = input_rib32_emit(task_id, bytes, len, type_rib32_line_cb, &write_ctx);
    if (err != ESP_OK) {
        if (write_ctx.error != INPUT_ERR_OK) {
            return write_ctx.error;
        }
        if (err == ESP_ERR_INVALID_ARG) {
            return INPUT_ERR_INVALID_COMMAND;
        }
        return INPUT_ERR_HID_INPUT_FAILED;
    }

    return INPUT_ERR_OK;
}

const input_writer_t input_hid_writer = {
    .name = "usb_hid",
    .init = hid_writer_init,
    .ready = hid_writer_ready,
    .write_text = input_hid_write_text,
    .ctx = NULL,
};

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
