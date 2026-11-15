*** Settings ***
Library           ${CURDIR}/../spice_robot.py    WITH NAME    Spice
Library           ${CURDIR}/../rpa_contract.py    WITH NAME    Contract

*** Variables ***
${SPICE_URI}      spice://127.0.0.1:5900

*** Keywords ***
Start RPA
    Contract.Begin Result    ${RPA_ID}
    Spice.Connect Spice    ${SPICE_URI}

Finish RPA Task
    IF    '${TEST STATUS}' == 'FAIL'
        Contract.Publish Failure If Missing    ${TEST MESSAGE}
    END

Stop RPA
    Spice.Disconnect Spice

Pause For User Verification
    [Arguments]    ${result}
    IF    $result['status'] in ['needs_user_captcha', 'needs_user_verification']
        Log To Console    ${result}[message]
        Skip    ${result}[message]
    END
