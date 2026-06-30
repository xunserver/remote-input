idf_component_register(
    SRCS
        "app_main.c"
        "ai_input_utf8.c"
        "ai_input_protocol.c"
        "ai_input_status.c"
        "ai_input_task.c"
    INCLUDE_DIRS "."
    REQUIRES
        bt
        nvs_flash
        esp_tinyusb
        tinyusb
)
