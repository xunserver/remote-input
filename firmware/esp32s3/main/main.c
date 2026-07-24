#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "class/hid/hid_device.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "host/ble_gatt.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "host/ble_uuid.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "nvs_flash.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "tinyusb.h"
#include "tinyusb_default_config.h"
#include "relay_frame.h"

#define USB_VID 0x303a
#define USB_PID 0x4002

static const char *TAG = "remote-copy-v2";
static uint8_t own_addr_type;
static uint16_t ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t notify_value_handle;
static bool notify_enabled;
static QueueHandle_t relay_queue;

typedef enum { RELAY_BLE_TO_USB, RELAY_USB_TO_BLE } relay_direction_t;
typedef struct {
    relay_direction_t direction;
    uint16_t length;
    uint8_t data[RELAY_REPORT_BYTES];
} relay_item_t;

// NimBLE UUID byte order is little-endian.
static const ble_uuid128_t service_uuid = BLE_UUID128_INIT(0x68,0x63,0x65,0x74,0x6f,0x5f,0x2d,0x9d,0x4f,0x4f,0x5a,0x6d,0x01,0x00,0x6b,0x7c);
static const ble_uuid128_t write_uuid   = BLE_UUID128_INIT(0x68,0x63,0x65,0x74,0x6f,0x5f,0x2d,0x9d,0x4f,0x4f,0x5a,0x6d,0x02,0x00,0x6b,0x7c);
static const ble_uuid128_t notify_uuid  = BLE_UUID128_INIT(0x68,0x63,0x65,0x74,0x6f,0x5f,0x2d,0x9d,0x4f,0x4f,0x5a,0x6d,0x03,0x00,0x6b,0x7c);

static int gatt_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg) {
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    uint16_t length = OS_MBUF_PKTLEN(ctxt->om);
    relay_item_t item = { .direction = RELAY_BLE_TO_USB, .length = length };
    if (length > sizeof(item.data) || os_mbuf_copydata(ctxt->om, 0, length, item.data) != 0 || !relay_frame_validate(item.data, length, false, NULL)) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    return xQueueSend(relay_queue, &item, 0) == pdTRUE ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static const struct ble_gatt_svc_def gatt_services[] = {
    { .type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &service_uuid.u,
      .characteristics = (struct ble_gatt_chr_def[]) {
        { .uuid = &write_uuid.u, .access_cb = gatt_access, .flags = BLE_GATT_CHR_F_WRITE },
        { .uuid = &notify_uuid.u, .val_handle = &notify_value_handle, .flags = BLE_GATT_CHR_F_NOTIFY },
        { 0 }
      }
    },
    { 0 }
};

static void advertise(void);
static int gap_event(struct ble_gap_event *event, void *arg) {
    (void)arg;
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) ble_conn_handle = event->connect.conn_handle;
            else advertise();
            return 0;
        case BLE_GAP_EVENT_DISCONNECT:
            ble_conn_handle = BLE_HS_CONN_HANDLE_NONE; notify_enabled = false; advertise(); return 0;
        case BLE_GAP_EVENT_SUBSCRIBE:
            if (event->subscribe.attr_handle == notify_value_handle) notify_enabled = event->subscribe.cur_notify != 0;
            return 0;
        case BLE_GAP_EVENT_ADV_COMPLETE: advertise(); return 0;
        default: return 0;
    }
}

static void advertise(void) {
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = (ble_uuid128_t *)&service_uuid; fields.num_uuids128 = 1; fields.uuids128_is_complete = 1;
    ESP_ERROR_CHECK(ble_gap_adv_set_fields(&fields));
    struct ble_hs_adv_fields scan_response = {0};
    const char *name = ble_svc_gap_device_name();
    scan_response.name = (uint8_t *)name; scan_response.name_len = strlen(name); scan_response.name_is_complete = 1;
    ESP_ERROR_CHECK(ble_gap_adv_rsp_set_fields(&scan_response));
    struct ble_gap_adv_params params = { .conn_mode = BLE_GAP_CONN_MODE_UND, .disc_mode = BLE_GAP_DISC_MODE_GEN };
    ESP_ERROR_CHECK(ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL));
}

static void ble_on_sync(void) {
    assert(ble_hs_util_ensure_addr(0) == 0);
    assert(ble_hs_id_infer_auto(0, &own_addr_type) == 0);
    advertise();
}

static void ble_host_task(void *arg) { (void)arg; nimble_port_run(); nimble_port_freertos_deinit(); }

static const uint8_t hid_report_descriptor[] = {
    0x06, 0x00, 0xff, 0x09, 0x01, 0xa1, 0x01,
    0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08,
    0x95, 0x40, 0x09, 0x01, 0x81, 0x02,
    0x95, 0x40, 0x09, 0x02, 0x91, 0x02, 0xc0,
};
static const tusb_desc_device_t device_descriptor = {
    .bLength = sizeof(tusb_desc_device_t), .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200, .bDeviceClass = 0, .bDeviceSubClass = 0, .bDeviceProtocol = 0,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE, .idVendor = USB_VID, .idProduct = USB_PID,
    .bcdDevice = 0x0200, .iManufacturer = 1, .iProduct = 2, .iSerialNumber = 3, .bNumConfigurations = 1,
};
static const char *string_descriptors[] = { (const char[]){0x09,0x04}, "Remote Copy", "Remote Copy HID Relay", "v2", "Relay" };
#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_HID_INOUT_DESC_LEN)
static const uint8_t configuration_descriptor[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, CONFIG_TOTAL_LEN, 0, 100),
    TUD_HID_INOUT_DESCRIPTOR(0, 4, false, sizeof(hid_report_descriptor), 0x01, 0x81, RELAY_REPORT_BYTES, 1),
};

uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance) { (void)instance; return hid_report_descriptor; }
uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t type, uint8_t *buffer, uint16_t reqlen) { (void)instance;(void)report_id;(void)type;(void)buffer;(void)reqlen; return 0; }
void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t type, const uint8_t *buffer, uint16_t size) {
    (void)instance; (void)report_id; (void)type;
    uint16_t frame_length = 0;
    relay_item_t item = { .direction = RELAY_USB_TO_BLE };
    if (size <= sizeof(item.data) && relay_frame_validate(buffer, size, true, &frame_length)) {
        item.length = frame_length;
        memcpy(item.data, buffer, item.length);
        xQueueSend(relay_queue, &item, 0);
    }
}

static void relay_task(void *arg) {
    (void)arg; relay_item_t item;
    while (xQueueReceive(relay_queue, &item, portMAX_DELAY) == pdTRUE) {
        if (item.direction == RELAY_BLE_TO_USB) {
            uint8_t report[RELAY_REPORT_BYTES] = {0}; memcpy(report, item.data, item.length);
            while (tud_mounted() && !tud_hid_ready()) vTaskDelay(pdMS_TO_TICKS(1));
            if (tud_mounted()) tud_hid_report(0, report, sizeof(report));
        } else if (ble_conn_handle != BLE_HS_CONN_HANDLE_NONE && notify_enabled) {
            struct os_mbuf *om = ble_hs_mbuf_from_flat(item.data, item.length);
            if (om) ble_gatts_notify_custom(ble_conn_handle, notify_value_handle, om);
        }
    }
}

void app_main(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) { ESP_ERROR_CHECK(nvs_flash_erase()); err = nvs_flash_init(); }
    ESP_ERROR_CHECK(err);
    relay_queue = xQueueCreate(16, sizeof(relay_item_t)); assert(relay_queue);
    xTaskCreate(relay_task, "relay", 4096, NULL, 5, NULL);

    const tinyusb_config_t usb = {
        .port = TINYUSB_PORT_FULL_SPEED_0,
        .phy = { .skip_setup = false, .self_powered = false, .vbus_monitor_io = -1 },
        .task = TINYUSB_TASK_DEFAULT(),
        .descriptor = {
            .device = &device_descriptor,
            .qualifier = NULL,
            .string = string_descriptors,
            .string_count = sizeof(string_descriptors) / sizeof(string_descriptors[0]),
            .full_speed_config = configuration_descriptor,
            .high_speed_config = NULL,
        },
        .event_cb = NULL,
        .event_arg = NULL,
    };
    ESP_ERROR_CHECK(tinyusb_driver_install(&usb));

    ESP_ERROR_CHECK(nimble_port_init());
    ble_svc_gap_init(); ble_svc_gatt_init();
    assert(ble_svc_gap_device_name_set("Remote Copy ESP32-S3") == 0);
    assert(ble_gatts_count_cfg(gatt_services) == 0);
    assert(ble_gatts_add_svcs(gatt_services) == 0);
    ble_hs_cfg.sync_cb = ble_on_sync;
    nimble_port_freertos_init(ble_host_task);
    ESP_LOGI(TAG, "BLE to USB HID relay started");
}
