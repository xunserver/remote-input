if(NOT DEFINED OUTPUT_FILE)
    message(FATAL_ERROR "OUTPUT_FILE is required")
endif()

set(ENV{TZ} "Asia/Shanghai")
execute_process(
    COMMAND date "+%Y.%m.%d"
    OUTPUT_VARIABLE REMOTE_INPUT_BUILD_DATE
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE DATE_RESULT
)

if(NOT DATE_RESULT EQUAL 0 OR REMOTE_INPUT_BUILD_DATE STREQUAL "")
    message(FATAL_ERROR "failed to determine firmware build date")
endif()

get_filename_component(OUTPUT_DIR "${OUTPUT_FILE}" DIRECTORY)
file(MAKE_DIRECTORY "${OUTPUT_DIR}")
file(WRITE "${OUTPUT_FILE}" "#include \"remote_input_firmware_version.h\"\n\n")
file(APPEND "${OUTPUT_FILE}" "const char *remote_input_firmware_version_get(void)\n")
file(APPEND "${OUTPUT_FILE}" "{\n")
file(APPEND "${OUTPUT_FILE}" "    return \"${REMOTE_INPUT_BUILD_DATE}\";\n")
file(APPEND "${OUTPUT_FILE}" "}\n")
