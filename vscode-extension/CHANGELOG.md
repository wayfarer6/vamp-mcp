# Changelog

## 0.3.2 (preview)

- Queue a dedicated Debian headless Podman VM through Packer and Vagrant from VS Code and MCP. Boot and SSH/rootless engine verification remain separate.
- Show the Windows host version in the Hyper-V panel without passive engine probing. Missing features are distinct from permission errors. A separate UAC diagnosis is read-only.
- Add native-Linux rootless workspace attachment to a new network-isolated disposable desktop, with owner-controlled configuration, pinned approval scope and explicit confirmation. No unlock, secret sharing or modification of existing containers. WSL/SSH workspace attachment remains unsupported.
- Harden KVM/Hyper-V bootstrap host resolution and scoped listeners; keep VirtualBox behavior unchanged.
- Keep one VAMP MCP registration and a separate unchanged VAMP Vault 0.1.8.
- Isolated tests do not establish actual VM provisioning, OCI display/browser behavior, GPU acceleration or real-volume write safety. Host integration remains a separate verification gate.

## 0.3.1

- Register one VAMP MCP server containing VM, RPA and Podman tools. Keep Vault separate.
- Add an explicit same-user, native Linux rootless Podman target.
- Add the Debian XFCE desktop container recipe with fixed 1920×1080 display, bundled noVNC packages, and optional NVIDIA/AMD recipes. No viewer listener is started.
- Add read-only encrypted workspace planning groundwork. Production Vault/engine probes and live display/GPU/volume tests are not part of this preview.

## 0.3.0

- Add a Containers panel and separate Podman MCP server for named rootless SSH connections.
- Add optional read-only Windows Podman/WSL discovery and an English manual setup guide. No system features or Podman machines are enabled or created by discovery.
- Add a source-only headless Debian Packer profile and matching VirtualBox/libvirt Vagrant handoff. Building and booting its boxes requires separate provider validation.
- Validation is limited to isolated unit and static checks; no official package or VM is validated by these source changes.

## 0.2.6

- Add a Vagrant lifecycle adapter (`backends/vagrant`) that follows the shared desktop interface: projects under `~/.vamp/vagrant`, a generated Vagrantfile with the SSH communicator, script server 8421 / VNC 5900 / RDP 3389 forwarding, synced folders and virtualbox, libvirt, hyperv, qemu and parallels provider blocks.
- Add a Vagrant provider plugin manager: per-platform and per-architecture provider selection, `vagrant plugin list` detection and `vagrant plugin install` for vagrant-libvirt, vagrant-qemu and vagrant-parallels. VirtualBox and Hyper-V stay built in. The VM Manager screens are unchanged; the adapter is registered through the shared host backend layer.
- Install and enable an SSH server in every Packer guest. Debian adds openssh-server to the preseed, enables ssh in the chroot and writes NOPASSWD sudoers for vboxuser and vagrant. Windows installs the OpenSSH.Server capability, starts sshd at boot, allows port 22 and sets the PowerShell DefaultShell. The Windows orchestrator fails the build when the sshd service, firewall rule or DefaultShell is missing.
- Warm the local OCR/YOLO model workers whenever an MCP server starts: the Python stdio server preloads through `model_daemon`, and the VirtualBox, RPA Library, remote SSH and npm CLI servers spawn `scripts/model_service.py start --no-wait` detached. `VAMP_PRELOAD_MODELS=0` turns this off and a host without the model environment only logs it.

## 0.2.5

- Persist Debian Full HD from GRUB through GDM and the user session with global monitors.xml deployment and boot restore services.
- Enforce automatic desktop login and disable sleep, idle blanking, dimming and automatic locking.
- Runtime tests for this Debian update were omitted at the user request.

## 0.2.4

- Overwrite Windows guest display registry sizes with 1920x1080 as the final elevated setup step for VirtualBox, KVM and Hyper-V.
- Apply the same backed-up registry update from the Desktop Full HD reset helper.

## 0.2.3

- Install Windows Guest Additions / virtio-win guest drivers during setup and resume elevated post-install setup after a driver reboot. Install English Full HD reset shortcuts on the Windows Desktop and Debian home folder. Share administrator/UAC handling across MCP and VSIX.

- Use HashiCorp Packer with checksum-pinned host CLI and official per-hypervisor plugins for VSIX/MCP VM creation. Share Debian/Windows installation and 60-second post-reboot guest setup across VirtualBox, Hyper-V and KVM.
- Enable Debian GNOME automatic login in the public sandbox. Export golden images before deploying separate live disks; show image paths, file sizes, logs and confirmed golden-image deletion in VM Manager and MCP.
- Build the Ubuntu KVM profile from native osinfo-db and virt-manager XML; adapt NAT/libvirt storage and Hyper-V Generation 2 networking. Hardware tests for KVM/Hyper-V are user-run.
- Catch the Windows ISO boot prompt with a one-second delay and an initial Enter burst; keep the first-login launcher below the Windows command limit.

## 0.2.2

- Elevate Windows keystroke setup with Ctrl+Shift+Enter, approve UAC using Left/Enter, require administrator rights and set Unrestricted execution policy for the setup process. Keep Linux and Windows display hooks registered at every desktop login.

- Show a persistent 1920×1080 / 100% guest display warning with Linux and Windows guide access. Bundle AI display preflight instructions and require resolution verification before coordinate automation.
- Use English interface guidance, reduce duplicate explanations and group recovery controls under More / Setup tools.
- Include reusable UI cleanup, packaged VSIX validation and RPA outcome-check skills in VSIX/npm runtimes and the release skills archive.
- Run Windows post-install setup in the first desktop session, pass its initial command safely through VirtualBox batch logging, and support clean Windows accounts without winget.
- Show prominent first-login/setup instructions and a manual Debian resolution command; configure guest automatic sleep and screen locking for automation.
- Show real web-server state, serialize start/stop requests, renew shared installation leases and keep downloads alive when an editor closes.
- Hide explicitly marked development VMs from normal inventory. Development names and validation artifacts are excluded from the VSIX.

## 0.2.1

- Share the desktop lifecycle interface across MCP and VSIX, separate VirtualBox/Hyper-V/KVM adapters by host support, and report Apple Hypervisor as not implemented. Normalize Unix shell scripts when packaging on Windows and when serving guest setup.

- Fix Windows PowerShell environment verification argument quoting. Debian VirtualBox and Hyper-V autoinstall now use GNOME preseed profiles and HTTP postinstall; VirtualBox supports an EFI preseed fallback for unsupported ISO detection and enables NAT host-loopback access. Hyper-V guest execution remains unverified.

## Unreleased

- **Python 3.15+ works on Linux, macOS and Windows.** Every host and guest script asks the interpreter for `sys.version_info` instead of matching version strings, so 3.15 and later releases are accepted the day they are installed. Ubuntu/SSH `scripts/remote_host_setup.sh` no longer rejects 3.15 with "install 3.11 or newer"; `scripts/windows/setup-host.ps1` and the remote SSH server use numeric version comparison.
- New `scripts/macos/setup-host.sh` prepares a Mac host: finds Python 3.11+ (python.org, Homebrew or `python3`), checks Node.js 22+, creates `.venv-virtualbox`, installs the host requirements and optionally builds the VirtualBox MCP adapter. It is copied into the VSIX and npm runtime.
- Windows guests reuse any installed Python 3.11+ (`setup-win.cmd`, `setup.ps1`, `setup-user.py`) and install one through winget only when none qualifies (3.15, then 3.12), instead of force-installing Python 3.12 over a newer interpreter.
- **The recorder payload is committed** as `guest_setup/recorder/recorder.zip` (regenerate with `scripts/build_recorder_zip.py`). Guest setup no longer stops when `third_party/pyautogui-recorder` is absent: `script_server.py`, `setup.sh`, `setup.ps1` and `setup-user.py` reuse the committed bundle and fall back to `https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/guest_setup/recorder/recorder.zip` when it is missing.

## 0.2.0

- **Guest setup moves to HTTP on port 8421.** `guest_setup/` is staged and served by `scripts/script_server.py` (Python standard library) in the VSIX runtime and the npm package. Guests download the same scripts on every platform: `wget -qO- http://10.0.2.2:8421/setup.sh | sh` (Debian/Ubuntu) or `powershell -ExecutionPolicy Bypass -Command "irm http://10.0.2.2:8421/setup.ps1 | iex"` (Windows). libvirt's default NAT network uses `192.168.122.1`. Port 8421 is fixed on purpose: it is not well-known and does not collide with 80/8800-style services.
- **xorriso removed.** VAMP no longer rewrites Debian installer ISOs. VirtualBox uses its own unattended installer for supported ISOs and otherwise boots the stock installer for a manual install. KVM boots the stock ISO with a preseed injected into the kernel/initrd. `scripts/build_debian_installer.py`, `scripts/remaster_debian_setup.py` and `scripts/build_nested_debian_media.py` now fail with guidance instead of calling `xorriso`.
- New MCP tools `vm_script_server_start`, `vm_script_server_status`, `vm_script_server_stop`. `vm_guest_bootstrap` starts the server (default `serveScripts:true`) and types the wget/`irm` command; `scriptServerUrl` selects the guest-visible host.
- The manager starts the server before **Inject Bootstrap**, adds **Start Script Server (8421)** / **Stop Script Server**, and stops it on deactivation; the server also stops after its 30-minute default TTL. It serves only the staged folder (no directory listing, no dotfiles) and logs each request.
- Unattended Debian post-install and Windows first-logon hooks now fetch `postdeb.sh` / `postwin.ps1` over HTTP with retries instead of scanning a mounted media ISO.
- **Inject Bootstrap** for VirtualBox desktops: a running Windows 11 or Debian guest gets its post-install script through keyboard injection, Packer style — Win+R → `cmd` → a click that pins keyboard focus → `powershell -ExecutionPolicy Bypass` → the script, sent in 50-character chunks. Debian clicks the screen centre and types into the open terminal, with optional Ctrl+Alt+T, TTY login and custom command. Available as the **Inject Bootstrap** button on a running desktop, the `vamp.bootstrapGuest` command and the `vm_guest_bootstrap` MCP tool (`dryRun:true` returns the plan). Creating a VM offers the script injection once the guest desktop appears; nothing is typed unasked.
- The focus click uses the VirtualBox API mouse helper (Python `vboxapi`) because `VBoxManage controlvm` has no mouse event subcommand. Without that helper the click is reported as a warning and the keystrokes are still sent.
- Delivery is never reported as success: results carry `verified:false` and the next action is to check the guest screen or its setup log.

## 0.1.9

- Require local privacy screening, AI structural-report review, an AI warning and explicit manual review before RPA ZIP export; bind approval to the exact exported bytes. Original source and recorded values are withheld from AI.
- Keep the recorder ISO detached during Debian fallback installation to avoid multiple-media ambiguity.

- Share KVM VM creation between the manager and the bundled KVM Host MCP server; add `remote_vm_create` to the standalone npm server.
- Add a Debian amd64 preseed installer path for KVM and VirtualBox ISO-detection fallback; preserve source ISOs and existing VM disks.
- Start VirtualBox provisioning headless and verify Running state instead of reporting command completion as successful startup.
- Detect active KVM/VirtualBox conflicts on Linux and explain legacy extension command collisions.
- Include the shared lifecycle bundle, Debian installer builder and preseed in both VSIX and npm artifacts.
- Public Debian sandbox login: `vboxuser` / `password123!`. OS installation, recorder setup and Vault setup remain separate verification stages. Hyper-V OS installation remains manual.


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
