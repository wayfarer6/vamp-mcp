*** Settings ***
Resource          ${CURDIR}/../common.resource
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Suite Setup       Start RPA
Suite Teardown    Stop RPA
Task Teardown     Finish RPA Task

*** Variables ***
${RPA_ID}         kvm_validation

*** Tasks ***
01 Terminal Keyboard
    ${result}=    Workflow.Terminal Keyboard Scenario
    Contract.Publish Result    ${result}

02 Local Browser Launch
    ${result}=    Workflow.Launch Local Browser
    Contract.Publish Result    ${result}

03 Mouse Click With OCR Verification
    ${result}=    Workflow.Click Local Button
    Contract.Publish Result    ${result}

04 Browser Keyboard Input
    ${result}=    Workflow.Type Into Local Page
    Contract.Publish Result    ${result}

05 YOLO And OCR Analysis
    ${result}=    Workflow.Analyze Local Page
    Contract.Publish Result    ${result}
