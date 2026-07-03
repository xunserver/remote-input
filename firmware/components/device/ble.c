#include "input_ble.h"

#include <limits.h>
#include <string.h>

#include "esp_log.h"
#include "host/ble_att.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "nvs_flash.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#define INPUT_BLE_DEVICE_NAME "Input-S3"
#define INPUT_DATA_FRAME_MAX_LEN (INPUT_DATA_FRAME_HEADER_LEN + INPUT_DATA_PAYLOAD_BYTES)

#if !defined(BLE_GAP_EVENT_CONNECT) && defined(BLE_GAP_EVENT_LINK_ESTAB)
#define BLE_GAP_EVENT_CONNECT BLE_GAP_EVENT_LINK_ESTAB
#endif

static const char *TAG = "input_ble";

/*
 * NimBLE stores 128-bit UUID values in little-endian byte order. These byte
 * arrays are the reverse of the canonical string form.
 */
static const ble_uuid128_t service_uuid =
    BLE_UUID128_INIT(0x01, 0x00, 0x12, 0x9a, 0x6c, 0x0d, 0x2a, 0x9c,
                     0x3b, 0x4d, 0x2a, 0x4f, 0x01, 0x00, 0x7b, 0x9e);
static const ble_uuid128_t control_uuid =
    BLE_UUID128_INIT(0x01, 0x00, 0x12, 0x9a, 0x6c, 0x0d, 0x2a, 0x9c,
                     0x3b, 0x4d, 0x2a, 0x4f, 0x02, 0x00, 0x7b, 0x9e);
static const ble_uuid128_t data_uuid =
    BLE_UUID128_INIT(0x01, 0x00, 0x12, 0x9a, 0x6c, 0x0d, 0x2a, 0x9c,
                     0x3b, 0x4d, 0x2a, 0x4f, 0x03, 0x00, 0x7b, 0x9e);
static const ble_uuid128_t status_uuid =
    BLE_UUID128_INIT(0x01, 0x00, 0x12, 0x9a, 0x6c, 0x0d, 0x2a, 0x9c,
                     0x3b, 0x4d, 0x2a, 0x4f, 0x04, 0x00, 0x7b, 0x9e);

static input_receiver_callbacks_t s_callbacks;
static uint8_t s_own_addr_type;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_status_val_handle;

static void start_advertising(void);
static int gap_event_cb(struct ble_gap_event *event, void *arg);
static int control_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                             struct ble_gatt_access_ctxt *ctxt, void *arg);
static int data_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt *ctxt, void *arg);
static int status_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                            struct ble_gatt_access_ctxt *ctxt, void *arg);

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &service_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &control_uuid.u,
                .access_cb = control_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE,
            },
            {
                .uuid = &data_uuid.u,
                .access_cb = data_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            {
                .uuid = &status_uuid.u,
                .access_cb = status_access_cb,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &s_status_val_handle,
            },
            { 0 },
        },
    },
    { 0 },
};

static int copy_om_to_buffer(struct os_mbuf *om, uint8_t *buf, size_t buf_size, uint16_t *out_len)
{
    if (om == NULL || buf == NULL || out_len == NULL || buf_size > UINT16_MAX) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    const uint16_t om_len = OS_MBUF_PKTLEN(om);
    if (om_len > buf_size) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    const int rc = ble_hs_mbuf_to_flat(om, buf, (uint16_t)buf_size, out_len);
    if (rc != 0 || *out_len != om_len) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    return 0;
}

static void notify_receiver_error(input_error_t error)
{
    if (s_callbacks.on_error != NULL) {
        s_callbacks.on_error(error, s_callbacks.ctx);
    }
}

static int control_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                             struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint8_t buf[INPUT_CONTROL_FRAME_LEN];
    uint16_t len = 0;
    int rc = copy_om_to_buffer(ctxt->om, buf, sizeof(buf), &len);
    if (rc != 0) {
        notify_receiver_error(INPUT_ERR_INVALID_COMMAND);
        return rc;
    }

    const uint8_t type = len > 1 ? buf[1] : 0;
    if (type == INPUT_CONTROL_CONFIG) {
        input_config_frame_t frame;
        if (!input_parse_config_frame(buf, len, &frame)) {
            notify_receiver_error(INPUT_ERR_INVALID_COMMAND);
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        if (s_callbacks.on_config != NULL) {
            s_callbacks.on_config(&frame, s_callbacks.ctx);
        }
        return 0;
    }

    input_control_frame_t frame;
    if (!input_parse_control_frame(buf, len, &frame)) {
        notify_receiver_error(INPUT_ERR_INVALID_COMMAND);
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    if (s_callbacks.on_control != NULL) {
        s_callbacks.on_control(&frame, s_callbacks.ctx);
    }

    return 0;
}

static int data_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint8_t buf[INPUT_DATA_FRAME_MAX_LEN];
    uint16_t len = 0;
    int rc = copy_om_to_buffer(ctxt->om, buf, sizeof(buf), &len);
    if (rc != 0) {
        notify_receiver_error(INPUT_ERR_INVALID_CHUNK);
        return rc;
    }

    input_data_frame_t frame;
    if (!input_parse_data_frame(buf, len, &frame)) {
        notify_receiver_error(INPUT_ERR_INVALID_CHUNK);
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    if (s_callbacks.on_data != NULL) {
        s_callbacks.on_data(&frame, s_callbacks.ctx);
    }

    return 0;
}

static int status_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                            struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint8_t status[INPUT_STATUS_FRAME_LEN];
    input_status_encode(status);
    int rc = os_mbuf_append(ctxt->om, status, sizeof(status));
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static void start_advertising(void)
{
    struct ble_hs_adv_fields fields;
    memset(&fields, 0, sizeof(fields));
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = &service_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to set advertising fields rc=%d", rc);
        return;
    }

    struct ble_hs_adv_fields rsp_fields;
    memset(&rsp_fields, 0, sizeof(rsp_fields));
    rsp_fields.name = (uint8_t *)INPUT_BLE_DEVICE_NAME;
    rsp_fields.name_len = strlen(INPUT_BLE_DEVICE_NAME);
    rsp_fields.name_is_complete = 1;

    rc = ble_gap_adv_rsp_set_fields(&rsp_fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to set scan response fields rc=%d", rc);
        return;
    }

    struct ble_gap_adv_params adv_params;
    memset(&adv_params, 0, sizeof(adv_params));
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &adv_params, gap_event_cb, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to start advertising rc=%d", rc);
    }
}

static int gap_event_cb(struct ble_gap_event *event, void *arg)
{
    (void)arg;

    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn_handle = event->connect.conn_handle;
            ESP_LOGI(TAG, "connected handle=%u", s_conn_handle);
            if (s_callbacks.on_connect != NULL) {
                s_callbacks.on_connect(s_callbacks.ctx);
            }
        } else {
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            start_advertising();
        }
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected reason=%u", event->disconnect.reason);
        if (event->disconnect.conn.conn_handle == s_conn_handle) {
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        }
        if (s_callbacks.on_disconnect != NULL) {
            s_callbacks.on_disconnect(s_callbacks.ctx);
        }
        start_advertising();
        return 0;

    case BLE_GAP_EVENT_CONN_UPDATE: {
        ESP_LOGI(TAG, "connection updated status=%d", event->conn_update.status);
        struct ble_gap_conn_desc desc;
        int rc = ble_gap_conn_find(event->conn_update.conn_handle, &desc);
        if (rc == 0) {
            ESP_LOGI(TAG,
                     "conn params interval=%u latency=%u supervision_timeout=%u",
                     desc.conn_itvl,
                     desc.conn_latency,
                     desc.supervision_timeout);
        } else {
            ESP_LOGW(TAG, "failed to read conn desc rc=%d", rc);
        }
        return 0;
    }

    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG,
                 "mtu updated conn_handle=%u channel_id=%u mtu=%u",
                 event->mtu.conn_handle,
                 event->mtu.channel_id,
                 event->mtu.value);
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        start_advertising();
        return 0;

    default:
        return 0;
    }
}

static void on_reset(int reason)
{
    ESP_LOGE(TAG, "host reset reason=%d", reason);
    s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
}

static void on_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to ensure identity address rc=%d", rc);
        return;
    }

    rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to infer address type rc=%d", rc);
        return;
    }

    start_advertising();
}

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void input_ble_notify_status(void)
{
    if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE && s_status_val_handle != 0) {
        uint8_t status[INPUT_STATUS_FRAME_LEN];
        input_status_encode(status);
        struct os_mbuf *om = ble_hs_mbuf_from_flat(status, sizeof(status));
        if (om == NULL) {
            return;
        }
        ble_gatts_notify_custom(s_conn_handle, s_status_val_handle, om);
    }
}

esp_err_t input_ble_init(const input_receiver_callbacks_t *callbacks)
{
    if (callbacks != NULL) {
        s_callbacks = *callbacks;
    } else {
        memset(&s_callbacks, 0, sizeof(s_callbacks));
    }
    s_conn_handle = BLE_HS_CONN_HANDLE_NONE;

    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ret = nvs_flash_erase();
        if (ret != ESP_OK) {
            return ret;
        }
        ret = nvs_flash_init();
    }
    if (ret != ESP_OK) {
        return ret;
    }

    ret = nimble_port_init();
    if (ret != ESP_OK) {
        return ret;
    }

    int rc = ble_att_set_preferred_mtu(256);
    if (rc != 0) {
        ESP_LOGW(TAG, "failed to set preferred mtu rc=%d", rc);
    }

    rc = ble_svc_gap_device_name_set(INPUT_BLE_DEVICE_NAME);
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to set device name rc=%d", rc);
        return ESP_FAIL;
    }
    ble_svc_gap_init();
    ble_svc_gatt_init();

    rc = ble_gatts_count_cfg(gatt_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to count GATT config rc=%d", rc);
        return ESP_FAIL;
    }

    rc = ble_gatts_add_svcs(gatt_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to add GATT services rc=%d", rc);
        return ESP_FAIL;
    }

    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.sync_cb = on_sync;

    nimble_port_freertos_init(host_task);
    return ESP_OK;
}

const input_receiver_t input_ble_receiver = {
    .name = "ble",
    .init = input_ble_init,
    .notify_status = input_ble_notify_status,
};
