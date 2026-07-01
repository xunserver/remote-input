#include "remote_input_ws.h"

#include "remote_input_protocol.h"
#include "remote_input_status.h"

#include "esp_check.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "sdkconfig.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

#define REMOTE_INPUT_WS_URI "/ws"
#define REMOTE_INPUT_DATA_FRAME_MAX_LEN (REMOTE_INPUT_DATA_FRAME_HEADER_LEN + REMOTE_INPUT_DATA_PAYLOAD_BYTES)

static const char *TAG = "remote_input_ws";

static remote_input_receiver_callbacks_t s_callbacks;
static httpd_handle_t s_server;
static int s_client_fds[CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS];
static portMUX_TYPE s_client_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_netif_initialized;
static bool s_event_loop_initialized;

static void reset_clients(void)
{
    portENTER_CRITICAL(&s_client_lock);
    for (size_t i = 0; i < CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS; i += 1) {
        s_client_fds[i] = -1;
    }
    portEXIT_CRITICAL(&s_client_lock);
}

static bool add_client(int fd)
{
    bool added = false;

    portENTER_CRITICAL(&s_client_lock);
    for (size_t i = 0; i < CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS; i += 1) {
        if (s_client_fds[i] == fd) {
            added = true;
            break;
        }
        if (s_client_fds[i] < 0) {
            s_client_fds[i] = fd;
            added = true;
            break;
        }
    }
    portEXIT_CRITICAL(&s_client_lock);

    return added;
}

static bool remove_client(int fd)
{
    bool removed = false;

    portENTER_CRITICAL(&s_client_lock);
    for (size_t i = 0; i < CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS; i += 1) {
        if (s_client_fds[i] == fd) {
            s_client_fds[i] = -1;
            removed = true;
            break;
        }
    }
    portEXIT_CRITICAL(&s_client_lock);

    return removed;
}

static void copy_client_fds(int *fds, size_t count)
{
    portENTER_CRITICAL(&s_client_lock);
    for (size_t i = 0; i < count; i += 1) {
        fds[i] = s_client_fds[i];
    }
    portEXIT_CRITICAL(&s_client_lock);
}

static void notify_error(remote_input_error_t error)
{
    if (s_callbacks.on_error != NULL) {
        s_callbacks.on_error(error, s_callbacks.ctx);
    }
}

static void notify_disconnect_if_removed(int fd)
{
    if (remove_client(fd) && s_callbacks.on_disconnect != NULL) {
        s_callbacks.on_disconnect(s_callbacks.ctx);
    }
}

static void remove_client_and_notify(int fd)
{
    notify_disconnect_if_removed(fd);
}

static esp_err_t send_status_to_fd(int fd, bool notify_on_failure)
{
    if (s_server == NULL || httpd_ws_get_fd_info(s_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
        if (notify_on_failure) {
            remove_client_and_notify(fd);
        } else {
            (void)remove_client(fd);
        }
        return ESP_FAIL;
    }

    uint8_t status[REMOTE_INPUT_STATUS_FRAME_LEN];
    remote_input_status_encode(status);

    httpd_ws_frame_t frame = {
        .final = true,
        .fragmented = false,
        .type = HTTPD_WS_TYPE_BINARY,
        .payload = status,
        .len = sizeof(status),
    };
    esp_err_t err = httpd_ws_send_frame_async(s_server, fd, &frame);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to send status fd=%d: %s", fd, esp_err_to_name(err));
        if (notify_on_failure) {
            remove_client_and_notify(fd);
        } else {
            (void)remove_client(fd);
        }
    }
    return err;
}

static esp_err_t recv_frame_payload(httpd_req_t *req, httpd_ws_frame_t *frame, uint8_t *payload)
{
    if (frame->len == 0) {
        frame->payload = NULL;
        return ESP_OK;
    }

    frame->payload = payload;
    return httpd_ws_recv_frame(req, frame, REMOTE_INPUT_DATA_FRAME_MAX_LEN);
}

static void handle_binary_frame(const uint8_t *payload, size_t len)
{
    if (payload == NULL) {
        notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
        return;
    }

    const uint8_t type = len > 1 ? payload[1] : 0;

    if (len == REMOTE_INPUT_CONTROL_FRAME_LEN &&
        (type == REMOTE_INPUT_CONTROL_START || type == REMOTE_INPUT_CONTROL_COMMIT)) {
        remote_input_control_frame_t frame;
        if (!remote_input_parse_control_frame(payload, len, &frame)) {
            notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
            return;
        }
        if (s_callbacks.on_control != NULL) {
            s_callbacks.on_control(&frame, s_callbacks.ctx);
        }
        return;
    }

    if (len >= REMOTE_INPUT_DATA_FRAME_HEADER_LEN && len <= REMOTE_INPUT_DATA_FRAME_MAX_LEN &&
        type == REMOTE_INPUT_DATA_FRAME) {
        remote_input_data_frame_t frame;
        if (!remote_input_parse_data_frame(payload, len, &frame)) {
            notify_error(REMOTE_INPUT_ERR_INVALID_CHUNK);
            return;
        }
        if (s_callbacks.on_data != NULL) {
            s_callbacks.on_data(&frame, s_callbacks.ctx);
        }
        return;
    }

    notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
}

static esp_err_t ws_post_handshake_cb(httpd_req_t *req)
{
    const int fd = httpd_req_to_sockfd(req);

    if (!add_client(fd)) {
        ESP_LOGW(TAG, "rejecting extra websocket client fd=%d", fd);
        return ESP_FAIL;
    }

    esp_err_t status_err = send_status_to_fd(fd, false);
    if (status_err != ESP_OK) {
        return status_err;
    }

    ESP_LOGI(TAG, "websocket connected fd=%d", fd);
    if (s_callbacks.on_connect != NULL) {
        s_callbacks.on_connect(s_callbacks.ctx);
    }
    return ESP_OK;
}

static esp_err_t ws_handler(httpd_req_t *req)
{
    const int fd = httpd_req_to_sockfd(req);

    httpd_ws_frame_t frame = { 0 };
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        remove_client_and_notify(fd);
        return err;
    }

    uint8_t payload[REMOTE_INPUT_DATA_FRAME_MAX_LEN];
    if (frame.len > sizeof(payload)) {
        notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
        remove_client_and_notify(fd);
        if (s_server != NULL) {
            httpd_sess_trigger_close(s_server, fd);
        }
        return ESP_ERR_INVALID_SIZE;
    }

    err = recv_frame_payload(req, &frame, payload);
    if (err != ESP_OK) {
        remove_client_and_notify(fd);
        if (frame.type != HTTPD_WS_TYPE_CLOSE) {
            notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
        }
        return err;
    }

    if (!frame.final || frame.type == HTTPD_WS_TYPE_CONTINUE) {
        notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
        remove_client_and_notify(fd);
        if (s_server != NULL) {
            httpd_sess_trigger_close(s_server, fd);
        }
        return ESP_ERR_INVALID_SIZE;
    }

    if (frame.type == HTTPD_WS_TYPE_CLOSE) {
        remove_client_and_notify(fd);
        return ESP_OK;
    }

    if (frame.type == HTTPD_WS_TYPE_PING || frame.type == HTTPD_WS_TYPE_PONG) {
        return ESP_OK;
    }

    if (frame.type != HTTPD_WS_TYPE_BINARY) {
        notify_error(REMOTE_INPUT_ERR_INVALID_COMMAND);
        return ESP_OK;
    }

    handle_binary_frame(payload, frame.len);
    return ESP_OK;
}

static void http_close_fn(httpd_handle_t hd, int sockfd)
{
    (void)hd;

    remove_client_and_notify(sockfd);
    close(sockfd);
}

static esp_err_t init_wifi_ap(void)
{
    if (strlen(CONFIG_REMOTE_INPUT_WIFI_AP_PASSWORD) < 8) {
        ESP_LOGE(TAG, "wifi ap password must be at least 8 characters");
        return ESP_ERR_INVALID_ARG;
    }

    if (!s_netif_initialized) {
        ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "esp_netif_init failed");
        s_netif_initialized = true;
    }

    if (!s_event_loop_initialized) {
        esp_err_t event_err = esp_event_loop_create_default();
        if (event_err != ESP_OK && event_err != ESP_ERR_INVALID_STATE) {
            ESP_LOGE(TAG, "event loop init failed: %s", esp_err_to_name(event_err));
            return event_err;
        }
        s_event_loop_initialized = true;
    }

    esp_netif_t *ap_netif = esp_netif_create_default_wifi_ap();
    if (ap_netif == NULL) {
        ESP_LOGE(TAG, "esp_netif_create_default_wifi_ap failed");
        return ESP_ERR_NO_MEM;
    }

    wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init_config), TAG, "esp_wifi_init failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "esp_wifi_set_storage failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_AP), TAG, "esp_wifi_set_mode failed");

    wifi_config_t wifi_config = { 0 };
    strlcpy((char *)wifi_config.ap.ssid, CONFIG_REMOTE_INPUT_WIFI_AP_SSID, sizeof(wifi_config.ap.ssid));
    strlcpy((char *)wifi_config.ap.password, CONFIG_REMOTE_INPUT_WIFI_AP_PASSWORD, sizeof(wifi_config.ap.password));
    wifi_config.ap.ssid_len = strlen(CONFIG_REMOTE_INPUT_WIFI_AP_SSID);
    wifi_config.ap.channel = CONFIG_REMOTE_INPUT_WIFI_AP_CHANNEL;
    wifi_config.ap.authmode = WIFI_AUTH_WPA2_PSK;
    wifi_config.ap.max_connection = CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS;

    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_AP, &wifi_config), TAG, "esp_wifi_set_config failed");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "esp_wifi_start failed");
    ESP_LOGI(TAG, "wifi ap started ssid=%s channel=%d", CONFIG_REMOTE_INPUT_WIFI_AP_SSID, CONFIG_REMOTE_INPUT_WIFI_AP_CHANNEL);
    return ESP_OK;
}

static esp_err_t init_http_server(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_open_sockets = CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS + 2;
    config.close_fn = http_close_fn;

    ESP_RETURN_ON_ERROR(httpd_start(&s_server, &config), TAG, "httpd_start failed");

    httpd_uri_t ws_uri = {
        .uri = REMOTE_INPUT_WS_URI,
        .method = HTTP_GET,
        .handler = ws_handler,
        .user_ctx = NULL,
        .is_websocket = true,
        .handle_ws_control_frames = true,
        .ws_post_handshake_cb = ws_post_handshake_cb,
    };
    ESP_RETURN_ON_ERROR(httpd_register_uri_handler(s_server, &ws_uri), TAG, "register ws uri failed");
    ESP_LOGI(TAG, "websocket endpoint ready at ws://192.168.4.1%s", REMOTE_INPUT_WS_URI);
    return ESP_OK;
}

void remote_input_ws_notify_status(void)
{
    int fds[CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS];
    copy_client_fds(fds, CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS);

    for (size_t i = 0; i < CONFIG_REMOTE_INPUT_WS_MAX_CLIENTS; i += 1) {
        if (fds[i] >= 0) {
            (void)send_status_to_fd(fds[i], true);
        }
    }
}

esp_err_t remote_input_ws_init(const remote_input_receiver_callbacks_t *callbacks)
{
    if (callbacks != NULL) {
        s_callbacks = *callbacks;
    } else {
        memset(&s_callbacks, 0, sizeof(s_callbacks));
    }

    reset_clients();

    esp_err_t err = init_wifi_ap();
    if (err != ESP_OK) {
        return err;
    }

    err = init_http_server();
    if (err != ESP_OK) {
        return err;
    }

    return ESP_OK;
}

const remote_input_receiver_t remote_input_ws_receiver = {
    .name = "ws",
    .init = remote_input_ws_init,
    .notify_status = remote_input_ws_notify_status,
};
