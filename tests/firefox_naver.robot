*** Settings ***
Library           ../spice_robot.py
Resource          firefox.resource
Suite Setup       Connect Spice    ${SPICE_URI}
Suite Teardown    Disconnect Spice

*** Variables ***
${SPICE_URI}      spice://127.0.0.1:5900
${NAVER_URL}      https://www.naver.com

*** Test Cases ***
Open Firefox And Visit Naver Through SPICE
    Open Firefox Using Guest Keyboard
    Guest Hotkey    ctrl    l
    Guest Write    ${NAVER_URL}
    Guest Hotkey    enter
    Sleep    10s
    Guest Hotkey    esc
    Capture Guest Screen    artifacts/naver.png
    Guest Screen Should Contain Text    www.naver.com
    Guest Screen Should Contain Text    NAVER
