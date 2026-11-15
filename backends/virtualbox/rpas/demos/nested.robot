*** Settings ***
Library    ${CURDIR}/workflow.py
Task Setup    Begin Demo    ${VM}    nested-windows-host    Windows host: diskless EFI VM startup and firmware menu keyboard navigation through MCP
Task Teardown    Finish Demo    ${TEST STATUS}

*** Variables ***
${VM}    Win-RPA
${WINDOWS_REPO}    C:/Users/vboxuser/VAMP-Lab/source
${NODE_DIRECTORY}    C:/Users/vboxuser/VAMP-Lab/tools/node-v22.23.5-win-x64
${WINDOWS_OUTPUT}    C:/Users/vboxuser/VAMP-Lab/nested-demo
${SHARED_OUTPUT}    //VBOXSVR/VAMPRecords/nested-demo
${HOST_OUTPUT}    ${EMPTY}
${INNER_VM}    ${EMPTY}

*** Tasks ***
Reuse Diskless Lab VM On Windows And Verify Firmware Input
    Should Not Be Empty    ${HOST_OUTPUT}
    Should Not Be Empty    ${INNER_VM}
    Prepare Nested Launcher    ${HOST_OUTPUT}    ${WINDOWS_REPO}    ${NODE_DIRECTORY}    ${INNER_VM}    ${WINDOWS_OUTPUT}    ${SHARED_OUTPUT}
    Tool    vm_keyboard_scancode    {"vm":"${VM}","keys":"win+r"}
    Sleep    1s
    Tool    vm_keyboard_type    {"vm":"${VM}","text":"powershell -NoProfile -NoExit -ExecutionPolicy Bypass -File //VBOXSVR/VAMPRecords/nested-launch.ps1","chunkSize":20,"delayMs":200}
    Tool    vm_keyboard_scancode    {"vm":"${VM}","keys":"enter"}
    Wait Until Keyword Succeeds    150s    4s    Verify Nested Firmware    ${HOST_OUTPUT}
    Sleep    2s
