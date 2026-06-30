idf_component_register(
    SRCS
        "ai_input_protocol.c"
        "ai_input_status.c"
        "ai_input_task.c"
        "ai_input_utf8.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES freertos
)
