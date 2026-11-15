*** Settings ***
Resource          ${CURDIR}/../common.resource
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Suite Setup       Start RPA
Suite Teardown    Stop RPA
Task Teardown     Finish RPA Task

*** Variables ***
${RPA_ID}         desktop_control
${ACTION}         capture
${TEXT}           ${EMPTY}
${X}              0
${Y}              0
${DX}             0
${DY}             0
${KEYS}           ${EMPTY}
${TEMPLATE}       ${EMPTY}
${LANGUAGES}      ko,en,ja,zh
${DEVICE}         auto

*** Tasks ***
Run One Desktop Action
    ${result}=    Workflow.Perform Desktop Action
    ...    action=${ACTION}    text=${TEXT}    x=${X}    y=${Y}
    ...    keys=${KEYS}    template=${TEMPLATE}
    ...    languages=${LANGUAGES}    device=${DEVICE}    dx=${DX}    dy=${DY}
    Contract.Publish Result    ${result}
