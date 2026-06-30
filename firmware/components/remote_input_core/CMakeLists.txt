idf_component_register(
    SRCS
        "remote_input_protocol.c"
        "remote_input_status.c"
        "remote_input_task.c"
        "remote_input_utf8.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES freertos
)
