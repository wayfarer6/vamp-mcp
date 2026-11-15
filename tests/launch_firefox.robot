*** Settings ***
Library           ../spice_robot.py
Resource          firefox.resource
Suite Setup       Connect Spice    ${SPICE_URI}
Suite Teardown    Disconnect Spice

*** Variables ***
${SPICE_URI}      spice://127.0.0.1:5900

*** Test Cases ***
Launch Firefox Through SPICE Keyboard
    Capture Guest Screen    artifacts/before.png
    Open Firefox Using Guest Keyboard
    Capture Guest Screen    artifacts/firefox.png
    Guest Screen Should Contain Text    Firefox
