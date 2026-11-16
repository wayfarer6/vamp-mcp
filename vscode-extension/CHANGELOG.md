# Changelog

## 0.1.8

- Fix the actual remote stdio MCP startup path and add a process-level handshake regression test.
- Add simultaneous guest hotkeys and paced KVM keyboard batches; split tablet press/release requests so real Windows dialogs receive clicks.
- Add remote pointer movement and VirtualBox SDK mouse support when the repository and matching Python runtime are configured.
- Clarify local RPA verification and compact output guidance to avoid repeatedly forwarding full OCR, YOLO, images or logs to an LLM.
- Fix Windows recorder dependency verification under PowerShell 5.1 and allow recorder/display setup to update files copied from read-only ISO media.
- Repository demos include Windows-host remote input and Microsoft Print to PDF workflows; full local vision/Robot dependencies remain separate from the basic VSIX runtime.

## 0.1.7

- Add **VAMP Remote (SSH)**: an SSH-based MCP server for desktops that live on another host, with `remote_env_check`, `remote_env_setup`, `remote_vm_list`, `remote_vm_status`, `remote_vm_start`, `remote_vm_stop`, `remote_vm_screenshot`, `remote_vm_send_keys`, `remote_vm_mouse_click` and `remote_rpa_run`.
- Remote screens are screenshots only (PNG per request); no live stream and no forwarded hypervisor port.
- Prepare the remote host from VS Code: upload the server to `~/.vamp/remote/`, create a Python venv, install libvirt/QEMU when passwordless sudo allows, and report the exact command for anything that needs an administrator.
- Add the `vamp.remote.*` settings, remote commands, the **VAMP Remote (SSH)** MCP provider and a remote view in the VM Manager that follows the existing VAMP look.
- KVM guests support absolute-pointer clicks through the QEMU monitor; VirtualBox remote hosts report clicks as unsupported instead of pretending.
- Document SSH keys, Tailscale/jump-host setups, troubleshooting and security boundaries in `docs/REMOTE_SETUP.md`.

## 0.1.6

- Add searchable RPA Library, editable creation forms, AI-assisted metadata and reviewed guest-device replay.
- Store each saved skill in a local Git repository; export only its latest committed revision and support reviewed AI repairs.
- Verify environment activation/imports, show a green check and support deletion/recreation.
- Adapt library and manager layouts to smaller windows and highlight selected sidebar actions.
- Bundle English/Korean usage instructions and document platform validation limits.

## 0.1.5

- Add the shared live KVM/VNC viewer and binary VM exchange integration.
- Prepare the matching checksum-verified VirtualBox Python SDK in the Windows managed environment so mouse input has its required COM bindings.
- Use the platform introduction: VM-isolated GUI RPA & Encrypted Vault Execution for AI Agents.
- Record native Windows extension-host, Hyper-V and Vault integration coverage separately from remaining VirtualBox checks.

## 0.1.4

- Generalize extension metadata from VirtualBox-only to local hypervisors (VirtualBox, KVM, Hyper-V).
- Document responsible use, human-in-the-loop guidelines, and liability disclaimer.
- Link companion VAMP Vault extension and unified VHD / guest setup guides.

## 0.1.3

- Refresh Marketplace documentation, quick start and links for `wayfarer6/vamp-mcp`.
- Explain the one-day prototype, local sandbox/OCR/RPA motivation and KVM/VirtualBox testing scope.
- Correct validation coverage and move detailed setup instructions to the documentation.
- Resize the Marketplace icon to 512×512 (242 KB) and enforce the 1024 KB packaging limit.
- Exclude optional repository-only video demos from the extension runtime.

## 0.1.2

Guest login display hooks, Debian network mirrors, optional Windows onboarding/licensing, GUI recording shares, explicit snapshots and Robot video/screenshot SQLite evidence.

## 0.1.1

Guest-native full HD defaults, scaled observation, screenshot resolution verification and Windows Guest Additions ISO/manual install handoff.

## 0.1.0

Initial VAMP preview: bundled VirtualBox MCP server, managed host Python venv, detachable observation, unattended Debian/Windows 11 VM creation and independent guest recorder bootstrap.
