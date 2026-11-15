*** Settings ***
Resource          ${CURDIR}/../common.resource
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Suite Setup       Start RPA
Suite Teardown    Stop RPA
Task Teardown     Finish RPA Task

*** Variables ***
${RPA_ID}         captcha_handoff
${LANGUAGES}      ko,en,ja,zh

*** Tasks ***
Inspect Current Verification Screen
    ${result}=    Workflow.Inspect Challenge    ${LANGUAGES}
    Contract.Publish Result    ${result}
    Pause For User Verification    ${result}
