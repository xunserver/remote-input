idf_component_register(
    SRCS
        "remote_input_ble.c"
        "remote_input_display.c"
        "remote_input_hid.c"
        "remote_input_led.c"
        "remote_input_service.c"
    INCLUDE_DIRS "include"
    REQUIRES
        remote_input_core
        bt
        nvs_flash
        esp_tinyusb
        tinyusb
        led_strip
        lvgl
    PRIV_REQUIRES freertos
)
