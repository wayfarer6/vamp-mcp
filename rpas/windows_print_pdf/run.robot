*** Settings ***
Library           ${CURDIR}/../../mcp_desktop_robot.py    WITH NAME    Desktop
Library           ${CURDIR}/workflow.py    WITH NAME    Workflow
Library           ${CURDIR}/../../rpa_contract.py    WITH NAME    Contract
Suite Setup       Prepare PDF Scenario
Suite Teardown    Desktop.Disconnect Remote Desktop
Task Teardown     Report PDF Failure

*** Variables ***
${RPA_ID}         windows_print_pdf
${MCP_CONFIG}     ${EMPTY}
${DOCUMENT_URL}   http://10.0.2.2:8766/invoice.html
${PDF_NAME}       auto
${VERIFY_CONFIG}  ${EMPTY}
${VERIFY_OCR}     True

*** Tasks ***
Print Invoice With Microsoft Print To PDF
    Desktop.Remote Chord    super+r
    Desktop.Wait And Capture    1    run-dialog
    Desktop.Remote Type    msedge.exe --no-first-run --new-window --start-maximized ${DOCUMENT_URL}
    Desktop.Remote Press    enter
    Desktop.Wait And Capture    8    invoice
    Desktop.Remote Press    esc
    Desktop.Wait And Capture    1    invoice-ready
    IF    ${VERIFY_OCR}
        Desktop.Verify Remote Text    VAMP ERP Invoice    invoice-verified
        Desktop.Analyze Remote Screen    invoice-targets
    END
    Desktop.Remote Chord    ctrl+shift+p
    Desktop.Wait And Capture    3    print-dialog
    Workflow.Select PDF Printer
    Desktop.Wait And Capture    2    save-dialog
    Desktop.Remote Type    C:\\Users\\Public\\VAMP-Exchange\\${PDF_NAME}
    Desktop.Remote Press    enter
    Desktop.Wait And Capture    4    printed
    ${result}=    Workflow.Verify PDF Artifact    ${VERIFY_CONFIG}    ${PDF_NAME}
    Contract.Publish Result    ${result}
    Should Be Equal    ${result}[status]    succeeded

*** Keywords ***
Prepare PDF Scenario
    Contract.Begin Result    ${RPA_ID}
    Should Not Be Empty    ${MCP_CONFIG}    Provide a local MCP launch configuration for the explicit target VM.
    Should Not Be Empty    ${VERIFY_CONFIG}    Provide the independent PDF artifact verification configuration.
    ${name}=    Workflow.Validate PDF Name    ${PDF_NAME}
    Set Suite Variable    ${PDF_NAME}    ${name}
    Workflow.Require New Guest PDF    ${VERIFY_CONFIG}    ${PDF_NAME}
    Desktop.Connect Remote Desktop    ${MCP_CONFIG}
    Workflow.Require FHD Desktop

Report PDF Failure
    IF    '${TEST STATUS}' == 'FAIL'
        Contract.Publish Failure If Missing    ${TEST MESSAGE}
    END
