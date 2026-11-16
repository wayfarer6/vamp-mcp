*** Settings ***
Library           ${CURDIR}/install_monitor.py

*** Variables ***
${VM_NAME}        vamp-debian-final
${SERIAL_LOG}     ${CURDIR}/../../../../artifacts/vms/${VM_NAME}/serial.log

*** Tasks ***
Debian ISO Installation And Guest Setup
    ${result}=    Wait For Debian Setup    ${VM_NAME}    ${SERIAL_LOG}
    Should Be Equal    ${result}[status]    installed_and_prepared
