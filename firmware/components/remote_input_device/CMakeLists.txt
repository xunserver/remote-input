idf_component_register(
    SRCS
        "remote_input_ble.c"
        "remote_input_display.c"
        "remote_input_hid.c"
        "remote_input_lcd_panel_st7789t.c"
        "remote_input_lcd_port.c"
        "remote_input_led.c"
        "remote_input_service.c"
        "remote_input_writer_runner.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "private_include"
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
