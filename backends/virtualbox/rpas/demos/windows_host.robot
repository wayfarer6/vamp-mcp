*** Settings ***
Library    ${CURDIR}/workflow.py
Task Setup    Begin Demo    ${VM}    windows-host-mcp    Windows host: real Node and Python MCP stdio validation
Task Teardown    Finish Demo    ${TEST STATUS}

*** Variables ***
${VM}    Win-RPA
${WINDOWS_REPO}    C:/Users/vboxuser/VAMP-Lab/source
${NODE_DIRECTORY}    C:/Users/vboxuser/VAMP-Lab/tools/node-v22.23.5-win-x64
${WINDOWS_OUTPUT}    //VBOXSVR/VAMPRecords/host-demo
${HOST_SHARE}    ${EMPTY}

*** Tasks ***
Run MCP Inside Windows Host And Verify Its Result
    Should Not Be Empty    ${HOST_SHARE}
    Prepare Windows Host Launcher    ${HOST_SHARE}    ${WINDOWS_REPO}    ${NODE_DIRECTORY}    ${WINDOWS_OUTPUT}
    Tool    vm_keyboard_scancode    {"vm":"${VM}","keys":"win+r"}
    Sleep    1s
    Tool    vm_keyboard_type    {"vm":"${VM}","text":"powershell -NoProfile -NoExit -ExecutionPolicy Bypass -File //VBOXSVR/VAMPRecords/host-launch.ps1","chunkSize":20,"delayMs":200}
    Tool    vm_keyboard_scancode    {"vm":"${VM}","keys":"enter"}
    Wait Until Keyword Succeeds    90s    3s    Verify Windows Host Report    ${HOST_SHARE}
    Verify Text    WINDOWS MCP PASS
    Sleep    2s
