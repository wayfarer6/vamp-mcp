*** Settings ***
Resource          ${CURDIR}/../common.resource
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Suite Setup       Start RPA
Suite Teardown    Stop RPA
Task Teardown     Finish RPA Task

*** Variables ***
${RPA_ID}         naver_login
${LANGUAGES}      en
${DEVICE}         auto

*** Tasks ***
Detect Naver Login Form
    ${state}=    Workflow.Detect Naver Login    ${LANGUAGES}    ${DEVICE}
    ${result}=    Workflow.Summarize Login State    ${state}
    Contract.Publish Result    ${result}
    Pause For User Verification    ${result}
    Should Be Equal    ${result}[status]    needs_credentials
    Should Be True    ${result}[origin_verified]
