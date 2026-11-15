*** Settings ***
Library    ${CURDIR}/workflow.py
Task Setup    Begin Demo    ${VM}    recorder-share    GUI action recorder: save Python and inspect through MCP without execution
Task Teardown    Finish Demo    ${TEST STATUS}

*** Variables ***
${VM}    Win-RPA
${HOST_SHARE}    ${EMPTY}

*** Tasks ***
Record A Real Click Save And Read Through MCP
    Should Not Be Empty    ${HOST_SHARE}
    Verify Text    SHARED WITH HOST
    Tool    vm_mouse_click    {"vm":"${VM}","x":126,"y":250}
    Sleep    1s
    Tool    vm_mouse_click    {"vm":"${VM}","x":1800,"y":800}
    Sleep    1s
    Tool    vm_keyboard_scancode    {"vm":"${VM}","keys":"f8"}
    Sleep    1s
    Tool    vm_mouse_click    {"vm":"${VM}","x":390,"y":250}
    Sleep    2s
    Verify Saved Recording    ${VM}    ${HOST_SHARE}    1800    800
    Sleep    2s
