*** Settings ***
Library    ${CURDIR}/workflow.py

*** Variables ***
${VM_NAME}    VAMP-Nested-Windows

*** Tasks ***
Verify Eight GB One Socket Eight Core Hyper-V Host
    Verify Nested Host Resources

Verify Nested VM Actually Running
    Verify Exact Nested VM    ${VM_NAME}

Launch Native VMConnect For Exact VM
    Open Actual Vmconnect    ${VM_NAME}
