idf_component_register(
    SRCS
        "app_main.c"
    INCLUDE_DIRS "."
    REQUIRES
        bt
        nvs_flash
        esp_tinyusb
        tinyusb
)
