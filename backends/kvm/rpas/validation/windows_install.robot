*** Settings ***
Library           ${CURDIR}/install_monitor.py

*** Variables ***
${VM_NAME}        vamp-windows-validation
${SERIAL_LOG}     ${CURDIR}/../../../../artifacts/vms/${VM_NAME}/serial.log

*** Tasks ***
Windows ISO Installation And Guest Tools Setup
    ${result}=    Install Windows And Wait    ${VM_NAME}    ${SERIAL_LOG}
    IF    $result['status'] == 'installation_in_progress'
        Skip    Installation continues; this recording segment reached its time limit.
    END
    Should Be Equal    ${result}[status]    installed_and_prepared
