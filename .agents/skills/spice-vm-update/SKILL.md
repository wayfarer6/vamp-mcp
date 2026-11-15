---
name: spice-vm-update
description: Run apt update as root in the authorized Debian sandbox VM using SPICE keyboard input and OCR-only terminal verification. Use for VM package-index refresh and its Robot Framework workflow.
---

Work from `/home/ssh1032007/spice_kvm_based_rpa` or the checkout containing this skill. Run `.venv/bin/python rpa.py vm-update`, or the Robot scenario `tests/vm_update.robot`. Read the compact JSON status first. `summary.json` contains the same summary; `artifacts/vm-update/result.json` retains the full OCR history. Read details only for an unresolved failure. `--full-result` opts into verbose CLI output when running the workflow.

This workflow refreshes package indexes with `apt update`. Package upgrades, source-list changes, installs and reboot are separate actions requiring task-specific authorization.

The current sandbox is `debian13` at `spice://127.0.0.1:5900`, hostname `debian`. `config/sandbox-vm.json` intentionally contains the owner's publicly distributable test root password. Use it only for this configured sandbox; do not reuse it or treat private website credentials as public. The current user explicitly authorized root login, apt update and publication of this test password.

The implementation uses Ctrl+Alt+T, then falls back to Alt+F2 → `gnome-terminal --maximize` if OCR does not confirm a terminal. It detects the shell hostname through OCR before entering shell commands. `su root` is followed by OCR verification of `Password:` before password entry and a root prompt plus an executed `id -u` check afterward. Do not retry a failed authentication automatically.

Judge success/failure from OCR text only. Do not invoke the image viewer, a multimodal model, SSH, a guest agent or host-side apt. Screenshot files are inputs to local PaddleOCR and are retained as evidence; the AI reads their OCR JSON instead of viewing them.

The root check and apt exit result are printed with octal-escaped printf markers so the echoed input command cannot be mistaken for successful execution. A success marker comes from exit status zero; warnings remain distinct. Report `succeeded`, `completed_with_warnings`, `failed` or an explicit unverified state exactly as returned. A missing marker or timeout is not success. On timeout the command may still be running: do not send more shell input until OCR confirms its state.

The completed workflow sends `exit` to leave the root shell. If apt fails, report the OCR error and the guest log path. Do not edit apt sources to turn the test green without a corresponding user request.
