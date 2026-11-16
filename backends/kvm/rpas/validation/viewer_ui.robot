*** Settings ***
Library           ${CURDIR}/viewer_ui.py
Suite Setup       Connect To Real VSCode
Suite Teardown    Disconnect VSCode

*** Tasks ***
01 Real RFB Stream And External Viewer Address Table
    Verify Live VNC Viewer

02 Resize And Reconnect Live Viewer
    Verify Viewer Resize And Reconnect
