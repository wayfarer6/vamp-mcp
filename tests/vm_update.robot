*** Settings ***
Library           ../spice_robot.py
Suite Setup       Connect Spice    ${SPICE_URI}
Suite Teardown    Disconnect Spice

*** Variables ***
${SPICE_URI}      spice://127.0.0.1:5900

*** Test Cases ***
Refresh Debian Package Indexes As Root Using OCR Only
    ${result}=    Update Sandbox Vm
    Log    ${result}[status]
    Should Be Equal    ${result}[verification]    ocr_only
    Should Be Equal    ${result}[status]    succeeded
