if(NOT CMAKE_SCRIPT_MODE_FILE)
    set(remote_input_generated_include_dir "${CMAKE_BINARY_DIR}/generated/remote_input_device")
    set(remote_input_firmware_version_source
        "${remote_input_generated_include_dir}/remote_input_firmware_version_generated.c"
    )
    set_source_files_properties(
        "${remote_input_firmware_version_source}"
        PROPERTIES GENERATED TRUE
    )
else()
    set(remote_input_firmware_version_source "")
endif()

idf_component_register(
    SRCS
        "remote_input_ble.c"
        "remote_input_display.c"
        "remote_input_hid.c"
        "remote_input_lcd_port.c"
        "remote_input_led.c"
        "remote_input_service.c"
        "remote_input_writer_runner.c"
        "${remote_input_firmware_version_source}"
    INCLUDE_DIRS "include"
    REQUIRES
        remote_input_core
        bt
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
            "-DOUTPUT_FILE=${remote_input_firmware_version_source}"
            -P "${CMAKE_CURRENT_LIST_DIR}/cmake/generate_firmware_version.cmake"
        BYPRODUCTS "${remote_input_firmware_version_source}"
        DEPENDS "${CMAKE_CURRENT_LIST_DIR}/cmake/generate_firmware_version.cmake"
        COMMENT "Generate Shanghai build-date firmware version"
        VERBATIM
    )

    add_dependencies(${COMPONENT_LIB} remote_input_firmware_version)
    set_property(DIRECTORY "${COMPONENT_DIR}" APPEND PROPERTY
        ADDITIONAL_MAKE_CLEAN_FILES "${remote_input_firmware_version_source}"
    )
endif()
