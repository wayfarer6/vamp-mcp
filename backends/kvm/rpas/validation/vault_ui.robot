*** Settings ***
Library           ${CURDIR}/vault_ui.py
Suite Setup       Connect To Real VSCode
Suite Teardown    Disconnect VSCode

*** Tasks ***
01 Installed CLI Setup In VSCode
    Verify Installed CLI Setup

02 Create Vault In VSCode
    Create Test Database In VSCode

03 Lock Unlock And Credential Search
    Lock And Unlock Real Secret Storage
