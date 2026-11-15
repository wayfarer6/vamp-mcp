*** Settings ***
Resource          ${CURDIR}/../common.resource
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Suite Setup       Start RPA
Suite Teardown    Stop RPA
Task Teardown     Finish RPA Task

*** Variables ***
${RPA_ID}         firefox_naver
${NAVER_URL}      https://www.naver.com

*** Tasks ***
Open Firefox And Visit Naver
    Spice.Guest Hotkey    alt    f2
    Sleep    1s
    Spice.Guest Write    firefox
    Spice.Guest Hotkey    enter
    Sleep    5s
    Workflow.Navigate To Naver    ${NAVER_URL}
    ${result}=    Workflow.Verify Naver
    Contract.Publish Result    ${result}
