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

- GitHub follow-up: authenticated as `wayfarer6`, renamed the repository to `wayfarer6/vamp-mcp`, updated the local origin and extension repository metadata, and successfully pushed `main` and `feat/vm-mcp-server`. This resolves the earlier GitHub authentication blocker. Marketplace authentication/publishing remains pending.

## Installed nested Windows workload — 2026-11-16

Ubuntu/KVM on Ryzen 7 5800H runs the independent `vamp-nested-hyperv-lab` Windows 11 Pro host with 8192 MiB and one socket, eight cores, one thread per core. The test VMs were scheduled for removal after packaging. Physical Windows hardware is not part of this test.

- Hyper-V installed and survived reboot. The new Generation 2 `VAMP-Nested-Windows` guest (4096 MiB, two vCPUs) booted to its Windows 11 Pro desktop. Host resources, exact VM state and native VMConnect launch passed all three Robot tasks.
- Native PowerShell Direct transferred 8193 random binary bytes into the guest, verified its read, received a guest-generated reversed-byte reply and verified both SHA-256 values. Guest and host overwrite protection and relative-path traversal rejection passed. Testing exposed and fixed a PowerShell boolean argument parsing error and remoting metadata leaking into the returned guest path.
- On Windows, the real Python stdio MCP server registered 18 tools, returned the live Hyper-V inventory and returned `needs_credentials` for an uncredentialed transfer. Full desktop/RDP input automation remains outside this Hyper-V backend. VMConnect is an external window; the embedded VS Code viewer remains KVM/VNC only.
- Visual C++ x64 runtime installation and DLL checks passed before the KeePassXC launch check (`keepassxc-cli 2.8.0`). Offline and standalone guest installation scripts now enforce this prerequisite before KeePassXC installation.
- The packaged Vault MCP server passed 17 native Windows checks: CLI discovery, database creation/overwrite rejection, grouped entry CRUD, approval, cache invalidation, encrypted storage, native VeraCrypt password-dialog mounting, real mounted-volume file IO and verified dismount. The first mounted fixture was read-only because its ISO source attribute was copied; clearing that attribute allowed the write/dismount checks to pass.
- VSIX versions 0.1.4 (VAMP) and 0.1.1 (Vault) installed in portable Windows VS Code 1.146.0. Both extensions activated in the real extension host; all contributed commands registered, guide execution, sidebar refresh/open and lock completed. The actual `vamp.setupPython` command also created its managed venv, installed the matching checksum-verified Oracle SDK and passed a native COM version probe. This does not claim every interactive UI path has been tested.
- Local Linux Vault tests with real KeePassXC/VeraCrypt passed 42 MCP checks and 18 extension-host stand-in checks. The VNC viewer bridge passed its two real-stream tests. These are distinct from native Windows results.
- VirtualBox 7.2.22 installed after resolving MSI error 1307 (full lab C: volume). A new NTFS data partition holds the relocated Hyper-V guest and an independent VHD clone; existing Windows/recovery partitions are retained. The VirtualBox clone reached its Windows desktop. In the initial Hyper-V/NEM coexistence boot, later screenshots remained identical and keyboard/mouse delivery did not produce a visible response, so guest input is not counted as verified. A separate one-time boot without Hyper-V encountered a VirtualBox startup access error. Further Windows VirtualBox testing was stopped at the user’s request; the Linux VirtualBox validation above is the release baseline.
- VNC uppercase input was corrected to preserve uppercase RFB keysyms. A real Windows console displayed `VAMP Upper ABC XYZ` with the correct case, and the four RFB transport tests passed, including balanced uppercase/lowercase key events.

Fresh, local receipts are collected with `scripts/collect_nested_evidence.py` into `artifacts/kvm-validation/nested-evidence/`; these generated artifacts are excluded from Git. Failures and subsequent passes remain in the history. Release versions are VAMP 0.1.5 and Vault 0.1.2. Marketplace publication is left to the user. A standalone UAC automation tool and an embedded Hyper-V viewer are not included.

## VAMP 0.1.6 / Vault 0.1.3 — 2026-11-16

- Python: 84 tests passed. VAMP manager/library/author: 12 passed; live stream bridge: 2 passed; embedded script syntax: 1 passed.
- With real Linux KeePassXC CLI: Vault smoke 39/39 and extension-host stand-in 18/18 passed; credential browser 2 tests and live approval-policy 7 checks passed.
- Both stable VSIX packages built successfully. Marketplace publication is reserved for the user.
- Actual UI and platform limits are recorded in [UI audit](UI_AUDIT.md). Physical Windows/macOS and the latest full visual sequence remain unverified.

## Vault 0.1.4 release follow-up — 2026-11-16

- Actual Linux KeePassXC/VeraCrypt checks: MCP smoke 42, extension-host stand-in 21, remote SSH stand-in 30, credential browser 2 and live approval policy 7 checks passed.
- The packaged 0.1.4 MCP server passed 15 native Windows checks in the existing nested Windows lab with temporary databases. Read approval, independent deletion consent, grouped CRUD, cache invalidation, overwrite rejection and encrypted on-disk storage passed. The native validator now tests deletion's own confirmation requirement instead of assuming an earlier read approval covers deletion.
- The VSIX passed isolated VS Code installation. The README now states accurately that the master password reaches the selected remote host through encrypted SSH stdin, while local approval and storage remain on this computer.
- Remote SSH tests use a stand-in transport; physical Windows hardware and native Windows volume mounting were not repeated in this 0.1.4 run. [Receipt](media/vault-014-validation.json).

## VAMP 0.1.9 provisioning and private RPA export — 2026-11-17

- KVM MCP `remote_vm_create` created a separate Debian 13.7 amd64 test VM. The unattended installer completion marker, reboot and Openbox/xterm desktop were observed. Test KVM was then shut down normally.
- A separate VirtualBox test with one prepared Debian installation DVD completed unattended OS installation and rebooted to its desktop. The recorder ISO is built but left detached on this fallback path. An intermittent apt media-configuration error was reported in a two-disc setup; its exact cause was not established and is not attributed conclusively to either networking or media selection.
- Simultaneous KVM and VirtualBox execution reproduced `VERR_SVM_IN_USE` and Guru Meditation. Creation/start checks now reject visible active guests of the other hypervisor. The existing VM used for initial diagnostics was returned to its original off state; its disks were retained. These checks cannot eliminate races with other applications starting a hypervisor later.
- Targeted tests cover real Running-state verification, Debian media preparation, resource/confirmation checks, system/session libvirt conflict detection, legacy extension collisions, MCP protocol, archive integrity and independent packaged installation. Full upstream suites were not rerun.
- Privacy tests verify that original code, filenames and recorded values are withheld from AI; local findings block export; AI denial/unavailability/cancellation and missing manual approval block export; and post-review changes invalidate approval. AI calls were tested with a mock provider. Images and arbitrary secrets still require manual inspection; the review is not a privacy guarantee.
- Hyper-V OS installation remains manual. This release does not verify automatic installation of recorder/Vault guest tools through every hypervisor. Physical Windows/macOS hosts were not retested.

- npm publication follow-up: `vamp-mcp@0.1.9` is public with the `latest` tag and `vamp-mcp-vault@0.1.6` is public. Both were installed directly from the registry in temporary directories and passed MCP initialization/tool discovery. The VAMP registry SHA-512 integrity matches the tested release tarball.
