*** Settings ***
Resource          ${CURDIR}/../common.resource
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Suite Setup       Start RPA
Suite Teardown    Stop RPA
Task Teardown     Finish RPA Task

*** Variables ***
${RPA_ID}              naver_login
${LANGUAGES}           en
${DEVICE}              auto
${CREDENTIAL_SOURCE}   environment

*** Tasks ***
Sign In To Naver
    ${state}=    Workflow.Detect Naver Login    ${LANGUAGES}    ${DEVICE}
    ${detected}=    Workflow.Summarize Login State    ${state}
    Contract.Publish Result    ${detected}
    Pause For User Verification    ${detected}
    Should Be Equal    ${detected}[status]    needs_credentials
    Should Be True    ${detected}[origin_verified]
    ${result}=    Workflow.Submit Login    ${state}    ${CREDENTIAL_SOURCE}
    Contract.Publish Result    ${result}
    Pause For User Verification    ${result}
    Should Be Equal    ${result}[status]    logged_in
