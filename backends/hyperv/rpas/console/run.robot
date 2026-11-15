*** Settings ***
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Library           ${CURDIR}/../../../../rpa_contract.py    WITH NAME    Contract
Suite Setup       Contract.Begin Result    hyperv_console
Task Teardown     Report Failure

*** Variables ***
${VM_NAME}        ${EMPTY}
${SERVER}         localhost
${START_VM}       ${FALSE}

*** Tasks ***
Open Hyper-V VMConnect Console
    Should Not Be Empty    ${VM_NAME}    Supply VM_NAME before invoking UAC.
    ${result}=    Workflow.Open Vm Console    ${VM_NAME}    ${SERVER}    ${START_VM}
    Contract.Publish Result    ${result}
    Should Be Equal    ${result}[status]    launch_requested

*** Keywords ***
Report Failure
    IF    '${TEST STATUS}' == 'FAIL'
        Contract.Publish Failure If Missing    ${TEST MESSAGE}
    END
