# Validation on Ubuntu + NVIDIA

Date: 2026-11-15. Existing VirtualBox 7.2.6 Windows 11 and Debian 13 VMs only; no new VM was created.

- Python suite: 63 tests passed. Upstream TypeScript suite: 101 tests passed.
- VSIX 0.1.2 packaged and installed in local VS Code; 19-tool protocol tests passed.
- Windows recorder: a real input recording was saved to the shared host folder and inspected without execution.
- Debian recorder: real click at (1800, 800) recorded, saved as rpa_20261115_231312_3969.py in the host share and read through MCP without execution; native 1920×1080 Xorg verified.
- Display hooks: Windows user32 after reboot and Debian GNOME/Xorg verified at 1920×1080.
- Robot execution evidence: actual Windows run produced native PNG screenshots, a decodable 640×360/5 fps WebM, and SQLite task/artifact records.
- Snapshot: live Debian snapshot failed with NS_ERROR_ABORT; both VMs were subsequently observed powered off. The shutdown cause was not established. An offline Debian snapshot was successfully created, listed and deleted. Restore was not performed; no test snapshot was retained.
- Windows ISO unattended preflight passed without creating a VM. Current Debian DVD detection returned NS_ERROR_NOT_IMPLEMENTED: fresh Debian unattended provisioning remains unverified for that ISO.
- Windows/macOS host hardware, fresh OS installation and snapshot restore remain untested. Marketplace publishing remains pending publisher authentication.

Public lab credentials are documented intentionally. Do not record real website credentials.
