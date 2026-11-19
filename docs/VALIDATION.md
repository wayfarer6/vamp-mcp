# Validation on Ubuntu + NVIDIA

For repeatable release acceptance on Windows and Linux, see the [practical QA scenarios](QA_SCENARIOS.ko.md).

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

## VAMP 0.2.6 Vagrant adapter, SSH provisioning and model warmup — 2026-11-17

- New `backends/vagrant` adapter (`desktop.cjs`, `templates.js`, `plugin-manager.cjs`) and its registration in `backends/common/host-backends.cjs`. Unit tests cover Vagrantfile rendering (SSH communicator, 8421/5900/3389 forwarding, synced folders, five provider blocks), input validation, plugin detection/installation, `global-status`/`ssh-config`/`port` parsing, created-project layout, start state verification, destroy guardrails, endpoint reporting, missing-Vagrant reporting and the shared backend registration. **No Vagrant binary, box, provider or guest ran here**: the adapter's host interaction is exercised through stand-in command runners only.
- SSH provisioning: Debian preseed and chroot post-install (`openssh-server`, unit detection, NOPASSWD sudoers, `sh -n` clean) and the Windows first-logon script (`OpenSSH.Server` capability, sshd automatic start, port 22 rule, PowerShell DefaultShell). Packer's rendered preseed carries the package, and the Windows orchestrator fails the build when sshd, the firewall rule or DefaultShell is missing. **No Debian or Windows installation was performed**, so first-boot sshd behaviour, `Add-WindowsCapability` requiring Windows Update access and guest-side sudoers are unverified on real guests.
- Model warmup: `backends/common/vision-preload.cjs` starts `scripts/model_service.py start --no-wait` detached from the VirtualBox, RPA Library, remote SSH and npm CLI servers, and `vm_mcp_server.py` keeps its `ensure_services(wait=False)` call. Unit tests cover the environment gate, entry-point selection, detached spawn arguments and both failure paths. **No model was loaded here**: the OCR/YOLO interpreters (`.venv`, `.venv-ocr`) and model weights were not present, so only the skip and start paths were observed.
- Test counts: `vscode-extension` `node --test` 84 of 85 passing; the one failure is `test/remote-ssh.cjs` "the remote command line expands $HOME and runs the uploaded server", which fails identically at commit 27a8f65 because the fixture copies only two `backends/common` files while `tools.mjs` imports `packer.cjs`. Python `unittest discover -s tests` ran 107 tests with 5 errors, all from this host lacking `gi`, `qemu-img`, `robot` and `pyautogui`. The new suites are `test/vagrant-backend.cjs`, `test/vision-preload.cjs` and `tests/test_guest_ssh.py`.
- Packaging: `artifacts/vamp-mcp-tools-0.2.6.vsix` (191 files, 2.03 MB) and `artifacts/vamp-mcp-0.2.6.tgz` (169 files, 734 kB). The packed tarball passed the install test 6 of 6, including MCP `initialize` against the packaged VirtualBox, RPA Library and remote servers. Registry publication was not completed: the supplied npm token returned 401 on `whoami` and 404 on `publish`, so 0.2.6 is distributed from the GitHub release tarball for now.

## VAMP 0.2.0 HTTP guest setup and xorriso removal — 2026-11-17

- `scripts/script_server.py` stages `guest_setup/` (recorder, vault, kvm helpers, recorder.zip, tar.gz and zip bundles) and serves it on the fixed port 8421. Local checks: staging manifest, bundle contents, `/healthz`, `/setup.sh`, `/` manifest, directory-listing 404, `../` traversal 404, start/status/stop round trip.
- The bundled VSIX runtime answered MCP `vm_script_server_start`/`status`/`stop` and served `setup.sh` over HTTP; `vm_guest_bootstrap` dry-run planned `wget -qO- http://10.0.2.2:8421/setup.sh | sh` and `powershell -ExecutionPolicy Bypass -Command "irm http://10.0.2.2:8421/setup.ps1 | iex"`.
- xorriso is no longer invoked. `scripts/build_debian_installer.py`, `scripts/remaster_debian_setup.py` and `scripts/build_nested_debian_media.py` raise a guidance error instead. VirtualBox unattended hooks and KVM creation plans were checked with stand-in command runners only: **no real VM, guest install or guest script execution was performed in this environment**. Debian automatic installation through virt-install's ISO `--location`/`--initrd-inject` path and the HTTP post-install hooks remain to be verified on a real host/guest.
- Test counts: `third_party/mcp-virtualbox` vitest 129 passed; `vscode-extension` node --test 57 passed; Python `tests.test_script_server` 5 passed and `tests.test_virtualbox_provision` 13 passed. Python modules that need `qemu-img`, `robot` or `gi` were not runnable on this host.

## VAMP 0.1.9 provisioning and private RPA export — 2026-11-17

- KVM MCP `remote_vm_create` created a separate Debian 13.7 amd64 test VM. The unattended installer completion marker, reboot and Openbox/xterm desktop were observed. Test KVM was then shut down normally.
- A separate VirtualBox test with one prepared Debian installation DVD completed unattended OS installation and rebooted to its desktop. The recorder ISO is built but left detached on this fallback path. An intermittent apt media-configuration error was reported in a two-disc setup; its exact cause was not established and is not attributed conclusively to either networking or media selection.
- Simultaneous KVM and VirtualBox execution reproduced `VERR_SVM_IN_USE` and Guru Meditation. Creation/start checks now reject visible active guests of the other hypervisor. The existing VM used for initial diagnostics was returned to its original off state; its disks were retained. These checks cannot eliminate races with other applications starting a hypervisor later.
- Targeted tests cover real Running-state verification, Debian media preparation, resource/confirmation checks, system/session libvirt conflict detection, legacy extension collisions, MCP protocol, archive integrity and independent packaged installation. Full upstream suites were not rerun.
- Privacy tests verify that original code, filenames and recorded values are withheld from AI; local findings block export; AI denial/unavailability/cancellation and missing manual approval block export; and post-review changes invalidate approval. AI calls were tested with a mock provider. Images and arbitrary secrets still require manual inspection; the review is not a privacy guarantee.
- Hyper-V OS installation remains manual. This release does not verify automatic installation of recorder/Vault guest tools through every hypervisor. Physical Windows/macOS hosts were not retested.

- npm publication follow-up: `vamp-mcp@0.1.9` is public with the `latest` tag and `vamp-mcp-vault@0.1.6` is public. Both were installed directly from the registry in temporary directories and passed MCP initialization/tool discovery. The VAMP registry SHA-512 integrity matches the tested release tarball.

## Keystroke bootstrap and Vault winget install — 2026-11-17

- This host is Ubuntu without VirtualBox, a running guest, `keepassxc-cli`, winget or a Windows host. Nothing below was executed against a real Windows or Debian desktop, and the UAC prompt and winget install were exercised only through a stand-in command runner.
- Upstream TypeScript adapter suite: 119 tests passed (101 existing + 18 for `vm_guest_bootstrap`), including the exact scancode/text sequence, chunking, dry-run planning, a failed focus click, a rejected keystroke and password redaction in a returned plan.
- VS Code manager suite: 52 tests passed (47 existing + 5), including the sequence through a stand-in VBoxManage, a refused injection into a stopped desktop and the create-flow offer.
- `node build.mjs` bundled `backends/virtualbox/server.mjs`; the bundled server started over stdio, listed 24 tools including `vm_guest_bootstrap`, and returned its plan for a `dryRun` call.
- The focus click uses the Python `vboxapi` mouse helper: `VBoxManage controlvm` has no mouse event subcommand (checked against `VBoxManageControlVM.cpp` and the 7.x command reference). Without that helper the click is reported as a warning and the keystrokes are still sent.
- Vault suite: smoke 34 checks, extension-host stand-in 10, remote SSH stand-in 18, credential browser 2. The winget checks assert the package ids, the English UAC notice, the `--id KeePassXCTeam.KeePassXC` invocation, a refused prompt and a missing winget; the VeraCrypt manual command is checked to contain `IDRIX.VeraCrypt` and not to run behind the user.
- `vault_add_credential` and the `vampVault.addCredential` command are covered by the tool list, command list, manifest and entry-path checks. Database-backed creation was not run here because no KeePassXC CLI is installed; it shares `VaultCli.addEntry` with the existing `vault_set_credential` path.
- Delivery is not execution: a guest script that ran, a winget package that installed and a UAC prompt that appeared remain unverified on real Windows hardware.

## Python 3.15 compatibility pass — 2026-11-17

- This host is Ubuntu with Python 3.12.16; no real Python 3.15 interpreter, Windows host or Mac was available. The 3.15 cases below were exercised with stand-in interpreters that report a 3.15 version tuple, not with an installed 3.15 release.
- `scripts/remote_host_setup.sh` now asks the interpreter for `sys.version_info >= (3, 11)` instead of matching `3.11.*|3.12.*|3.13.*|3.14.*|4.*`. A stand-in reporting 3.15.0 produced `Python 3.11+ (supports 3.15+)` with status `ok`; one reporting 3.10.14 produced `needs_manual` with `found 3.10.14; install 3.11 or newer`. Both runs were `--dry-run` against the real script.
- `backends/remote_ssh/tools.mjs` compares versions numerically and tolerates suffixes (`3.15.0rc1`, `v22.14.0`). Two new tests in `vscode-extension/test/remote-ssh.cjs` cover the ordering and drive `envSetup`/`envCheck` against a stand-in `python3` reporting 3.15.0 and 3.10.14; the remote SSH suite passed 16 tests.
- `scripts/macos/setup-host.sh` was executed end to end on Ubuntu behind a `uname` stand-in reporting Darwin: it found Python 3.12.16 and Node.js 22.14.0, created `.venv-virtualbox`, installed `backends/virtualbox/requirements.txt` (all imports succeed) and printed the next steps. No Mac hardware or Apple-silicon VirtualBox was involved.
- `scripts/windows/setup-host.ps1`, `guest_setup/recorder/setup-win.cmd` and `guest_setup/recorder/setup.ps1` were changed but not run: this host has no PowerShell or cmd.exe. The Python 3.11+ assertion, the newest-first interpreter search and the winget fallback (3.15, then 3.12) remain unverified on Windows.
- Recorder bundle: `guest_setup/recorder/recorder.zip` (39,075 bytes, 9 files) is committed and `scripts/build_recorder_zip.py --check` reports it current. `scripts/script_server.py`, `setup.sh`, `setup.ps1` and `setup-user.py` fall back to the GitHub raw URL. New tests in `tests/test_script_server.py` stage a copy of `guest_setup` with no `third_party` sources and download the bundle from a local HTTP server; the suite passed 8 tests.
- Suites: `third_party/mcp-virtualbox` vitest 129 passed, VS Code extension `node --test` 59 passed, Python `unittest discover -s tests` 98 run with 2 errors (`gi` and `qemu-img` missing in this environment, identical to the same run on commit b216805). The VSIX repackaged to `artifacts/vamp-mcp-tools-0.2.0.vsix` (1.95 MB) and contains `dist/runtime/guest_setup/recorder/recorder.zip` and `dist/runtime/scripts/macos/setup-host.sh`.
