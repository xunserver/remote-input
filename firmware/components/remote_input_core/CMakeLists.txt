idf_component_register(
    SRCS
        "remote_input_engine.c"
        "remote_input_protocol.c"
        "remote_input_status.c"
        "remote_input_task.c"
        "remote_input_utf8.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_common
    PRIV_REQUIRES freertos
)
