*** Settings ***
Library           ${CURDIR}/../../mcp_desktop_robot.py    WITH NAME    Desktop
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Library           ${CURDIR}/../../rpa_contract.py    WITH NAME    Contract
Suite Setup       Prepare Remote Scenario
Suite Teardown    Desktop.Disconnect Remote Desktop
Task Teardown     Report Failure

*** Variables ***
${RPA_ID}         remote_host_validation
${MCP_CONFIG}     ${EMPTY}

*** Tasks ***
Windows Host Remote Keyboard And Mouse
    Workflow.Launch Remote Fixture
    Desktop.Wait And Capture    10    browser-opened
    Desktop.Remote Press    f11
    Desktop.Wait And Capture    3    qhd-page
    Desktop.Verify Remote Text    WAITING FOR INPUT    ready-verified
    Desktop.Remote Click    0.5    0.55
    Desktop.Wait And Capture    2    clicked
    Desktop.Verify Remote Text    REMOTE INPUT VERIFIED    result-verified
    ${result}=    Workflow.Remote Validation Result
    Contract.Publish Result    ${result}
    Should Be Equal    ${result}[status]    succeeded

*** Keywords ***
Prepare Remote Scenario
    Contract.Begin Result    ${RPA_ID}
    Should Not Be Empty    ${MCP_CONFIG}
    Desktop.Connect Remote Desktop    ${MCP_CONFIG}

Report Failure
    IF    '${TEST STATUS}' == 'FAIL'
        Contract.Publish Failure If Missing    ${TEST MESSAGE}
    END
