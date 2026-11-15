---
name: hyperv-rpa
description: Use the separate Windows Hyper-V RPA backend to inspect/start a requested VM and open vmconnect.exe with normal UAC elevation. Use for Hyper-V host code and console launch, not SPICE connections or claims of completed RDP input automation.
---

Read `backends/hyperv/README.md`. This backend is separate from Linux/SPICE `rpas/`. Current capabilities are exact VM selection, optional startup, normal administrator elevation and VMConnect process launch. RDP frame/input automation is not implemented. The code is untested on Windows; the project owner plans to test there.

Run only on the user's Windows Hyper-V host. Use `.venv-hyperv` and `backends/hyperv/requirements.txt`; do not install Linux GI or reuse `spice_robot.py`. Current Ubuntu `windows-RPA` is a KVM guest, not evidence of a working Hyper-V host.

Robot entrypoint: `backends/hyperv/rpas/console/run.robot`; Python: `workflow.py` plus `backends/hyperv/scripts/vmconnect.py`; elevated native worker: `Open-HyperVConsole.ps1`. Supply the exact `VM_NAME`, optional `SERVER` and explicit `START_VM:True` only when startup is requested. Do not change a saved/paused VM state automatically.

The Python launcher requests standard Windows UAC approval via runas if not already elevated. Let the user approve it. Do not send clicks/credentials to UAC, disable UAC, weaken policies or silently install Hyper-V. The worker uses structured data, matches the VM name exactly and starts only Off VMs when explicitly enabled.

Read summary status. `launch_requested` is process launch plus VM Running, not verified guest access; `guest_connection_verified` remains false. Do not announce login/RPA success from opening VMConnect. On timeout inspect the existing console/UAC state before another launch.

Future RDP implementations need their own screenshot/input adapter and verified guest-area coordinates. Reuse Robot task logic and OCR/YOLO where practical; do not route Hyper-V commands into a SPICE URI. Windows applications start through Win+R and executable names, not desktop-icon coordinates. Exclude credential/UAC entry from macro recording.
