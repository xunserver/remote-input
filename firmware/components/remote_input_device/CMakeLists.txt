if(NOT CMAKE_SCRIPT_MODE_FILE)
    set(generated_include_dir "${CMAKE_BINARY_DIR}/generated/remote_input_device")
    set(firmware_version_source
        "${generated_include_dir}/remote_input_firmware_version_generated.c"
    )
    set_source_files_properties(
        "${firmware_version_source}"
        PROPERTIES GENERATED TRUE
    )
else()
    set(firmware_version_source "")
endif()

idf_component_register(
    SRCS
        "ble.c"
        "config.c"
        "display.c"
        "hid.c"
        "rib32.c"
        "lcd_port.c"
        "led.c"
        "service.c"
        "writer_runner.c"
        "ws.c"
        "${firmware_version_source}"
    INCLUDE_DIRS "include"
    REQUIRES
        remote_input_core
        bt
        esp_event
        esp_http_server
        esp_netif
        esp_wifi
        nvs_flash
        esp_tinyusb
        tinyusb
        led_strip
        esp_driver_gpio
        esp_driver_ledc
        esp_driver_spi
        esp_lcd
        esp_timer
    PRIV_REQUIRES
        freertos
        lvgl
)

if(NOT CMAKE_SCRIPT_MODE_FILE)
    add_custom_target(remote_input_firmware_version
        ALL
        COMMAND "${CMAKE_COMMAND}"
            "-DOUTPUT_FILE=${firmware_version_source}"
            -P "${CMAKE_CURRENT_LIST_DIR}/cmake/generate_firmware_version.cmake"
        BYPRODUCTS "${firmware_version_source}"
        DEPENDS "${CMAKE_CURRENT_LIST_DIR}/cmake/generate_firmware_version.cmake"
        COMMENT "Generate Shanghai build-date firmware version"
        VERBATIM
    )

    add_dependencies(${COMPONENT_LIB} remote_input_firmware_version)
    set_property(DIRECTORY "${COMPONENT_DIR}" APPEND PROPERTY
        ADDITIONAL_MAKE_CLEAN_FILES "${firmware_version_source}"
    )
endif()
