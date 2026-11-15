*** Settings ***
Library           ../spice_robot.py
Suite Setup       Connect Spice    ${SPICE_URI}
Suite Teardown    Disconnect Spice

*** Variables ***
${SPICE_URI}       spice://127.0.0.1:5900
${LOGIN_SUBMIT}    ${FALSE}

*** Test Cases ***
Detect Naver Login And Request Credential Handoff
    ${state}=    Prepare Naver Login
    Should Be Equal    ${state}[status]    needs_credentials
    Should Be True    ${state}[origin_verified]
    Log    Login form detected. AI should request credentials using the private host dialog.
    IF    ${LOGIN_SUBMIT}
        ${result}=    Submit Naver Login From Environment    ${state}
        Log    ${result}[status]
        Should Be Equal    ${result}[status]    logged_in
    END
