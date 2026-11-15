# VAMP — Virtual Agent Machine Platform

Local VM tools for AI agents and Robot Framework RPA, exposed through MCP. This preview extension registers **VAMP VirtualBox** with VS Code. It bundles the Node MCP server; you do not need a separate Node installation to run it in desktop VS Code.

## Quick start

1. Install **VirtualBox 7.x** and **Python 3.11+** on the host computer. Debian/Ubuntu may also need `python3-venv` installed by the OS package manager.
2. Install this extension and run **VAMP: Set Up Python Environment** from the Command Palette. It creates a private venv in VS Code's extension storage, not the system environment.
3. Open MCP server management, select **VAMP VirtualBox**, and start/trust the server. Tool availability depends on your Copilot/client version and policy.
4. Run **VAMP: Create VM From ISO** for a file picker without an AI loop. Alternatively list existing VMs, or give the agent a **local installation ISO path** and ask it to call `vm_create`. You can also call tools from another MCP client using the server in the repository.

Unattended creation uses publicly documented sandbox credentials:

| Setting | Default |
| --- | --- |
| Username | `vboxuser` |
| Password | `password123!` |
| RAM / CPUs / dynamic disk | 4096 MB / 2 / 64 GB |
| Frontend | `separate` |

These credentials are intentionally public. VirtualBox may use the same password for the guest administrator/root account. The initial unattended profile supports detected **Debian amd64** and **Windows 11 x64** installation media. Windows edition/image index or a valid product key may be needed for a particular ISO. No activation bypass is provided.

## Observe while the agent works

Use VirtualBox Manager **Show** to watch the guest. Close the frontend using **Detach / continue in background**, rather than shutdown, power off or save state. VM input/capture uses guest coordinates and continues independently of the frontend process. `separate` does not guarantee that the initial frontend is hidden on every host/version.

## Guest recorder environment

`vm_create` builds and attaches a recorder ISO. The unattended postinstall hook installs a desktop `RPA-Recorder` folder on Debian, or stages installation for the first `vboxuser` desktop login on Windows. The Windows bootstrap uses winget to install Python in that guest user profile. Both installers create a guest-local venv and a recorder launcher. Installation needs guest internet access. It never automatically records keyboard input. Record → Stop → Download exports Python code; avoid recording passwords.

An existing VM can use `vm_prepare_recorder` to build media and optionally attach it to an empty DVD slot while powered off. Installing software inside the VM is separate from the host-side venv.

## Platform and dependency limits

The extension is designed for Windows, Linux and macOS hosts, but has **not been hardware-tested across those platforms**. Apple Silicon/ARM guests are outside the initial amd64 unattended profile. The current developer validation covers Ubuntu + NVIDIA for the existing SPICE stack; VirtualBox also has live Ubuntu-host tests with existing Windows 11/Debian 13 guests, including native input, shared recording and Robot evidence. New VM creation and actual snapshot/restore were not executed.

Keyboard and screenshots use VBoxManage. Mouse clicks additionally require a matching host **VirtualBox Python SDK (`vboxapi`)** and USB tablet configuration. Set `vamp.mousePythonExecutable` to the SDK-capable Python. System drivers/VirtualBox/SDK are not installed by pip.

The bundled host venv installs basic control/provisioning requirements only. **YOLO/PaddleOCR and the SPICE/Hyper-V backends are not bundled in this extension preview**; the full repository has separate installation profiles. Models and their runtimes can be large and retain their own licenses.

`installation_started` means the installer was launched, not that Windows/Debian or the recorder finished installing. The VM continues installing without an AI polling loop. Inspect the guest and local provisioning journal to determine completion. Errors leave partial VMs and disks for inspection; no automatic deletion or overwrite of existing VMs occurs.

## Settings

- `vamp.pythonExecutable`: optional Python used to create the host venv.
- `vamp.vboxManagePath`: optional VBoxManage executable path.
- `vamp.mousePythonExecutable`: optional host Python with VirtualBox SDK bindings.

The extension runs on the local desktop host, including when the editor has a remote workspace. Paths supplied to tools therefore refer to the **VM host**, not an arbitrary remote workspace. This extension requires desktop VS Code and does not run in vscode.dev.

## License and attribution

VAMP's original host integration is MIT. Bundled upstream MCP input/display code is from [chryaner/mcp-virtualbox](https://github.com/chryaner/mcp-virtualbox), MIT; notices are included in `dist/notices`.

The independent guest recorder is from [axel-magard/PyAutoGUI-Recorder](https://github.com/axel-magard/PyAutoGUI-Recorder), **GPL-3.0**, preserved with source, images, LICENSE and provenance under `dist/runtime/third_party/pyautogui-recorder`. It runs as a separate guest program. The root MIT license does not relicense it. VirtualBox and optional vision models retain their separate licenses.

No telemetry is implemented by VAMP. Dependency downloads use their package registries, and the MCP client determines what tool results are sent to a model provider.

This project was developed with user direction and AI-assisted coding. This is an experimental preview; fresh unattended OS installation and Windows/macOS host UI behavior still require testing before a production release. Existing Ubuntu-host guest setup was exercised.

## Native resolution and scaled observation

Both Debian GNOME and Windows guests use **1920×1080 native resolution, OS scale 100%, browser zoom 100%**. In GNOME select Settings → Displays → Resolution 1920×1080 → Scale 100% → Apply/Keep Changes. In Windows select Settings → System → Display → Display resolution 1920×1080 → Scale 100%.

The VirtualBox **View → Scaled Mode** frontend can be small while the guest framebuffer remains full HD. Guest auto-resize is disabled by default. An already-open frontend may require detach/reopen or a manual View menu change.

For Windows, VAMP tries to insert the host's Guest Additions ISO into a reserved DVD slot. After OS installation, open the CD in Windows, run **VBoxWindowsAdditions.exe**, approve UAC, install and reboot. Installation is manual. If the matching host ISO is unavailable, pass its path to `vm_insert_guest_additions`; occupied media is never replaced. Then call `vm_configure_display` to send a resolution hint and check actual screenshot pixels. A configured hint is not proof that the guest accepted the mode.

## Onboarding, recordings and history

First-time setup checks VirtualBox, offers Debian by default, and asks separately before Windows creation. Current defaults match the observed VirtualBox guests: Windows 4096 MB/2 CPUs/250 GiB dynamic disk; Debian 2048 MB/2 CPUs/250 GiB. Ubuntu reuses Debian resources but is unverified. Windows requires your own valid license and activation after installation.

The guest GUI recorder offers visible Start/Stop/Save/Open Folder/Copy Path controls. VAMPRecords shares save Python recordings directly to host `~/VAMP/recordings`; fallback local saving is explicitly labeled. Modified GUI recorder code remains GPL-3.0 with source/license included. Guest display scripts reapply native full HD at each user login. Debian setup disables APT CD-ROM entries and configures official network mirrors.

Robot RecordingListener optionally captures low-resolution VM video and screenshots with SQLite execution history at `~/VAMP/history.sqlite3`. MCP tools `vm_run_history` and `vm_run_artifact` provide bounded viewing. Video is opt-in, 640×360/5fps/180s/20MB/no audio; it uses VirtualBox, not an additional host recorder. Snapshots are separate: ask first, explain storage use, and restore only a confirmed target on a powered-off VM.

VirtualBox ISO detection can fail for particular media/build combinations. Preflight failure is not an installation success; no VM is created by `preflight_only:true`. Host Windows/macOS/ARM compatibility remains unverified hardware coverage.
