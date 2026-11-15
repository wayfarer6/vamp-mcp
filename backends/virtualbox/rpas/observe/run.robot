*** Settings ***
Library    ${CURDIR}/workflow.py

*** Variables ***
${VM_NAME}       ${EMPTY}
${SCREENSHOT}    ${OUTPUT DIR}/virtualbox-screen.png

*** Tasks ***
Observe Existing VirtualBox VM
    Should Not Be Empty    ${VM_NAME}
    ${result}=    Observe Vm    ${VM_NAME}    ${SCREENSHOT}
    Log    ${result}
    Should Be Equal    ${result}[status]    completed
