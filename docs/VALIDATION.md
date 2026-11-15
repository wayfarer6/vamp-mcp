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
- Physical Windows/macOS host hardware, fresh OS installation and snapshot restore remain untested. Windows MCP processes were additionally exercised inside Win-RPA; see below. Marketplace publishing remains pending publisher authentication.

Public lab credentials are documented intentionally. Do not record real website credentials.


## Windows host and Robot demo follow-up — 2026-11-16

- Ubuntu controller → Win-RPA Windows 11 → VirtualBox 7.2.6. Inside Windows, Node 22.23.5 and Python 3.12.10 ran the real stdio MCP server. Inventory, setup information and SQLite history checks passed.
- Existing diskless EFI lab VM `VAMP-Nested-Smoke-20261115-235230` was reused. Windows-host MCP returned VM inventory/info/start, screen information and PNG capture. No additional VM or OS installation was created in this follow-up.
- Earlier interrupted scenarios exposed the Win+R command length limit: long commands truncated output paths. Arguments now live in shared PowerShell launcher files. Host-report freshness is checked to reject old success markers.
- Python suite: 63 passed. Upstream adapter: 101 passed. Four demo suites pass Robot dry-run with the required variables supplied.
- VSIX 0.1.2 repackaged; optional repo-only demos are excluded from the extension runtime.
- Existing keyboard/OCR, recorder-share and Windows MCP recordings decode successfully at 2560×1440. Keyboard and recorder durations: 18.5 and 20.9 seconds; each under 1 MB. The Windows MCP video was subsequently regenerated with fresh JSON verification. Source guest frames are 1920×1080, nominal 2 fps, padded without scaling.
- Git HTTPS push still fails for missing authentication. Marketplace `verify-pat wayfarer6` still returns TF400813. The connected GitHub tool also returned RemoteProtocolError. Neither push nor publishing is complete.

Windows-host mouse SDK/COM injection, a nested installed guest OS workload, physical Windows/macOS hardware and snapshot restore are outside the verified scope.

- Nested Robot scenario passed: before/after PNGs captured through the Windows-host MCP show Boot Manager Menu → firmware main menu after ESC. OCR verifies both states; the whitespace split in “Dev ice Manager” is normalized. [Verification JSON](media/nested-firmware-verification.json) preserves both OCR outputs and transport results. [QHD console recording](media/nested-windows-host.mp4), [before](media/nested-firmware-before.png), [after](media/nested-firmware-after.png). The inner firmware resolution is 1280×800; the recorded outer Windows desktop is native 1920×1080 on a 2560×1440 canvas.

- Updated Windows-host Robot scenario passed using the short launcher, a fresh Windows result JSON and OCR of the console success line. [Fresh report](media/windows-host-verification.json) and [video timeline](media/windows-host-mcp.json). Final VSIX 0.1.2 installed locally after packaging.
