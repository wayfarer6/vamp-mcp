*** Settings ***
Resource          ${CURDIR}/../common.resource
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Suite Setup       Contract.Begin Result    ${RPA_ID}
Suite Teardown    Stop RPA
Task Teardown     End Recorded Task

*** Variables ***
${RPA_ID}         windows_naver_recorded
${ALLOW_REPLAY}   ${FALSE}
${EXPECTED_TEXT}  ${EMPTY}
${LANGUAGES}      ko,en
${DEVICE}         auto

*** Tasks ***
Replay Reviewed Guest Recording
    ${ready}=    Workflow.Load Recording    ${ALLOW_REPLAY}
    IF    not $ready
        ${review}=    Workflow.Review Result
        Contract.Publish Result    ${review}
        Skip    Review conversion.json and recording.local.json; set ALLOW_REPLAY only after review.
    END
    Spice.Connect Spice    ${SPICE_URI}
    Workflow.Check Guest Geometry
    ${count}=    Workflow.Action Count
    FOR    ${index}    IN RANGE    ${count}
        Workflow.Replay Event    ${index}
    END
    ${result}=    Workflow.Verify Naver Login Reached    ${LANGUAGES}    ${DEVICE}
    Contract.Publish Result    ${result}
    Pause For User Verification    ${result}
    Should Be Equal    ${result}[status]    succeeded

*** Keywords ***
End Recorded Task
    Run Keyword And Continue On Failure    Workflow.Release Recorded Inputs
    Finish RPA Task
