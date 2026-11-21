*** Settings ***
Library    workflow.py

*** Test Cases ***
Verify Headless Guest Keyboard And Save Result
    Verify GUI    ${ARTIFACT}
