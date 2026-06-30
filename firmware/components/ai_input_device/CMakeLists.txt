idf_component_register(
    SRCS
        "ai_input_ble.c"
        "ai_input_hid.c"
        "ai_input_service.c"
    INCLUDE_DIRS "include"
    REQUIRES
        ai_input_core
        bt
        nvs_flash
        esp_tinyusb
        tinyusb
    PRIV_REQUIRES freertos
)
