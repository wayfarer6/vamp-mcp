*** Settings ***
Resource          ${CURDIR}/../common.resource
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Suite Setup       Start RPA
Suite Teardown    Stop RPA
Task Teardown     Finish RPA Task

*** Variables ***
${RPA_ID}         firefox_launch

*** Tasks ***
Launch Firefox
    Workflow.Open Firefox
    ${result}=    Workflow.Verify Firefox
    Contract.Publish Result    ${result}
