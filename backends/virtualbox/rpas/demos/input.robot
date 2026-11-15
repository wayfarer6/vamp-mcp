*** Settings ***
Library    ${CURDIR}/workflow.py
Task Setup    Begin Demo    ${VM}    keyboard-ocr    Windows keyboard input and OCR verification
Task Teardown    Finish Demo    ${TEST STATUS}

*** Variables ***
${VM}    Win-RPA

*** Tasks ***
Launch Program Through Common Launcher And Verify Text
    Tool    vm_keyboard_scancode    {"vm":"${VM}","keys":"win+r"}
    Sleep    1s
    Tool    vm_keyboard_type    {"vm":"${VM}","text":"notepad"}
    Tool    vm_keyboard_scancode    {"vm":"${VM}","keys":"enter"}
    Sleep    4s
    Tool    vm_keyboard_type    {"vm":"${VM}","text":"VAMP Robot Framework MCP demo"}
    Sleep    2s
    Verify Text    VAMP Robot Framework
    Sleep    2s
