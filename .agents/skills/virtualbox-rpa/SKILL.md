---
name: virtualbox-rpa
description: Control or observe an authorized VirtualBox VM through the pinned mcp-virtualbox adapter and separate Robot/Python packages; supports detachable user observation.
---

Read `backends/virtualbox/README.md` in the project for installation and commands. Use `backends/virtualbox/client.py` or the stdio server; SPICE URIs and Hyper-V VMConnect are separate backends.

List VMs before selecting a target. Start only when requested; default `vm_start` frontend is `separate` so the user can observe via VirtualBox Manager Show. Detach the UI to keep the VM running; do not select shutdown/save/power-off. Starting is not evidence the guest or application is ready.

Keep each scenario as a folder with `.robot`, `workflow.py` and manifest under this backend. Launch Windows programs through Win+R, Linux GNOME through Alt+F2 or another environment-appropriate common launcher rather than desktop icon positions. Send keyboard/mouse to the VM, using coordinates from the VM screenshot, not the host observation window. Mouse clicks require USB tablet plus working host VirtualBox Python SDK. Do not install a guest automation agent just to control input.

For UI success, run existing OCR/YOLO on captured PNGs and check task-specific evidence; no success solely because keys were sent. Keep model workers loaded when vision is used. This backend currently provides capture/input and an observation example, not an already-validated VirtualBox login RPA. Do not claim hardware testing without user evidence.

Credentials belong in a private user entry flow, not CLI arguments, committed recordings or logs. On CAPTCHA/additional verification, pause for the user and recheck after completion. Do not automatically retry credential submission.

For unattended VM creation, ask for the host ISO path if missing, disclose public defaults `vboxuser` / `password123!`, then call `vm_create` once. It detects supported ISO types, creates a new VM and starts a deterministic installer; no AI polling loop is needed for OS installation. Do not call again merely because the response says installation_started. Preserve partial failures and inspect the journal. Recorder setup is wired to Debian postinstall / Windows first desktop login; installed flags remain unverified until checked. See `docs/GUEST_RECORDER.md`.

VAMP's VS Code extension bundles basic VirtualBox tools and offers a managed host venv; it does not bundle the full vision stack or the SPICE MCP branch. Marketplace publish requires a publisher account; existing editor GitHub login is not evidence of publisher access.

Guest-native resolution is 1920x1080 for both GNOME Debian and Windows; OS/browser scale 100%. Use Scaled Mode only for the host frontend, with guest auto-resize disabled. See `docs/VM_DISPLAY.md`. `vm_configure_display` checks screenshot dimensions; do not claim resolution is correct from a sent hint alone. Windows `vm_insert_guest_additions` inserts media only; tell the user to install VBoxWindowsAdditions.exe, approve UAC and reboot. Never replace an occupied storage slot or silently run the guest installer.
