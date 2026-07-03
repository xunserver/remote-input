idf_component_register(
    SRCS
        "engine.c"
        "protocol.c"
        "status.c"
        "task.c"
        "utf8.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_common
    PRIV_REQUIRES freertos
)
