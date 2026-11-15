# VAMP — Virtual Agent Machine Platform

**Local VirtualBox tools for AI agents and Robot Framework, exposed through MCP.** Inspect VMs, capture screens, send keyboard/mouse input and inspect recordings from VS Code.

[Documentation](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/README.md) · [Source](https://github.com/wayfarer6/vamp-mcp) · [Releases](https://github.com/wayfarer6/vamp-mcp/releases)

## Get started

1. Install **VirtualBox 7.x** and **Python 3.11+** on the local host. Debian/Ubuntu may also need `python3-venv`.
2. Run **VAMP: Set Up Python Environment** from the Command Palette to create the extension's private host venv.
3. Open MCP server management and start/trust **VAMP VirtualBox**. Client version and policy determine tool availability.
4. Ask the agent to list existing VMs, inspect one and capture its screen. For new installations, run **VAMP: Create VM From ISO** and choose a host-local ISO.

The Node MCP server is bundled and runs with desktop VS Code; a separate Node installation is unnecessary. VirtualBox, system drivers and Python are installed separately. This extension runs on the local desktop host, including when a remote workspace is open; tool paths refer to that host. It does not run in vscode.dev.

## What you can do

- List, inspect and explicitly start VMs with detachable observation.
- Capture screens and send keyboard input. Mouse clicks additionally need the matching **host VirtualBox Python SDK (`vboxapi`)** and USB tablet configuration; Windows also needs its COM Python support.
- Start ISO-based unattended provisioning and prepare an optional guest GUI recorder.
- Read shared recording sources without executing them, and inspect Robot screenshots, video and SQLite run history.
- Configure native FHD display hints and perform explicitly selected snapshot operations.

The extension exposes **19 MCP tools**. See the [tool reference](https://github.com/wayfarer6/vamp-mcp/blob/main/backends/virtualbox/README.md) and [architecture](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/MCP_ARCHITECTURE.md).

## Observe and record

Use VirtualBox Manager **Show** to observe a running VM. Choose **Detach / continue in background** when closing the frontend to keep the VM running. Guest screenshots and input use guest coordinates independently of the viewer window.

The optional GUI recorder saves Python action recordings through `VAMPRecords` to the host. Robot execution video is a separate opt-in feature. Imported recording source is inspected before replay. See [guest recorder setup](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/GUEST_RECORDER.md), [run history](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/EXECUTION_HISTORY.md) and [real demo videos](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/DEMOS.md).

## Settings

| Setting | Purpose |
| --- | --- |
| `vamp.pythonExecutable` | Optional Python for creating the host venv. |
| `vamp.vboxManagePath` | Optional VBoxManage executable path. |
| `vamp.mousePythonExecutable` | Host Python with matching VirtualBox SDK bindings. |

## Before creating a VM

Initial unattended profiles target detected **Debian amd64** and **Windows 11 x64** media. Public sandbox credentials are **`vboxuser` / `password123!`**; the guest administrator/root password may be the same. Windows requires your own valid license and activation. Guest recorder setup requires guest internet access.

`installation_started` confirms the installer was launched, not OS or recorder installation completion. Failed provisioning leaves partial VMs and disks for inspection. See [guest preparation](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/GUEST_AUTOMATION.md) for resource profiles, display setup, sharing and snapshots.

## Preview status

Built in one day through user-directed vibe coding with Codex. This early prototype has substantial gaps in completeness, reliability, error handling and documentation. The goal is to combine a local VM sandbox with OCR/UI recognition and reusable RPA workflows to reduce repeated AI token use for GUI tasks.

Only KVM/SPICE and VirtualBox have been tried so far. Hyper-V remains experimental and untested.

Validated on an Ubuntu host with existing Windows 11/Debian 13 guests, plus Windows-host MCP processes and an inner diskless EFI VM in a nested lab. **Fresh unattended OS installation completion, snapshot restore and physical Windows/macOS hardware remain unverified.** ARM guests are outside the initial unattended profiles.

YOLO/PaddleOCR and SPICE/Hyper-V backends are available separately in the repository and are not bundled in this extension. [Detailed validation](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/VALIDATION.md)

## License

Original integration: **MIT**. Bundled [mcp-virtualbox](https://github.com/chryaner/mcp-virtualbox) code: MIT. The independent guest [PyAutoGUI-Recorder](https://github.com/axel-magard/PyAutoGUI-Recorder): **GPL-3.0**, with source and license included. VirtualBox and optional models retain their own licenses. [Third-party notices](https://github.com/wayfarer6/vamp-mcp/blob/main/THIRD_PARTY_NOTICES.md)

VAMP implements no telemetry. The MCP client controls which tool results it sends to a model provider. Developed with user direction and AI-assisted coding.
