*** Settings ***
Library    ${CURDIR}/workflow.py

*** Variables ***
${VM_NAME}          Debian-RPA
${LOGIN_REQUIRED}   ${FALSE}
${SCRIPT_PATH}      /opt/rpa-recorder-setup/configure-debian-mirrors.py

*** Tasks ***
Debian Login And Network Mirrors
    ${result}=    Setup Debian Network    ${VM_NAME}    ${LOGIN_REQUIRED}    ${SCRIPT_PATH}
    Log    ${result}
    Should Be Equal    ${result}[status]    succeeded
