*** Settings ***
Resource          ${CURDIR}/../common.resource
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Suite Setup       Start RPA
Suite Teardown    Stop RPA
Task Teardown     Finish RPA Task

*** Variables ***
${RPA_ID}         debian_update
${VM_CONFIG}      config/sandbox-vm.json
${APT_TIMEOUT}    300

*** Tasks ***
Refresh Debian Package Indexes
    ${result}=    Workflow.Refresh Debian Indexes    ${VM_CONFIG}    ${APT_TIMEOUT}
    Contract.Publish Result    ${result}
    Should Be Equal    ${result}[status]    succeeded
