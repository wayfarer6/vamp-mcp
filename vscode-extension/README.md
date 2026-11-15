<p align="center">
  <img src="https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/vscode-extension/icon.png" width="128" height="128" alt="VAMP bat and virtual machine icon">
</p>

# VAMP · Virtual Agent Machine Platform

Record a GUI task once, turn the reviewed actions into a reusable RPA, and let an AI agent call it again by name and inputs. VAMP is being built to reduce the tokens spent repeatedly inspecting screens and reconstructing the same GUI workflow.

Opening the Naver login page is one example: launch a browser, navigate to the page and check that the expected form appeared. The reusable workflow keeps those steps and checks in local Robot/Python code. The agent can read the result summary first, then inspect logs or screenshots when needed.

This VS Code extension provides the VirtualBox MCP tools. Recording conversion, SPICE execution and local OCR/UI recognition are separate parts of the repository. Arbitrary CUA recordings cannot be imported automatically, and the recorded-action converter currently targets SPICE rather than VirtualBox replay.

[Workflow example](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/WORKFLOWS.md) · [Documentation](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/README.md) · [Releases](https://github.com/wayfarer6/vamp-mcp/releases)

## Get started

1. Install VirtualBox 7.x and Python 3.11+ on the local host. Debian/Ubuntu may also need `python3-venv`.
2. Run **VAMP: Set Up Python Environment** to create the extension's private host venv.
3. Open MCP server management and start/trust **VAMP VirtualBox**. Tool availability depends on the client and its policy.
4. Ask the agent to list an existing VM and capture its screen. For a new VM, use **VAMP: Create VM From ISO** with a host-local ISO.

The bundled Node server runs with desktop VS Code. VirtualBox, system drivers and Python must be installed separately. The extension runs on the local desktop host even when a remote workspace is open, so tool paths refer to that host. It does not run in vscode.dev.

## Records, logs and screens

| Material | How to inspect it |
| --- | --- |
| Saved GUI action source | List and read selected shared recordings without executing them. |
| Run status and events | Query SQLite history through `vm_run_history`. |
| Saved screenshot | Use `vm_run_artifact` with `show_image:true` for the selected artifact. |
| Current screen | Capture it with `vm_screenshot`. |
| Execution video | Open the returned local path in a host player; recording is opt-in. |
| Robot log and report | Open `log.html`, `report.html` and `output.xml` in the host output folder. |

Observation must be enabled with a Robot listener or an explicit observation session. Direct MCP input is not automatically logged in full. History tools return bounded events and artifact lists; they do not read every Robot log file. [Storage and retrieval](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/EXECUTION_HISTORY.md)

The extension also provides VM inventory/start, keyboard/mouse input, display setup, ISO installation startup and explicit snapshot tools, for 19 MCP tools in total. Mouse input needs the matching host VirtualBox Python SDK (`vboxapi`) and USB tablet configuration; Windows hosts also need COM Python support. [Tool reference](https://github.com/wayfarer6/vamp-mcp/blob/main/backends/virtualbox/README.md)

## Watch a running VM

Use VirtualBox Manager **Show** to open the guest. Choose **Detach / continue in background** when closing the frontend. Screenshots and input use guest coordinates independently of the viewer window.

The optional GUI recorder saves Python action recordings through `VAMPRecords` to the host. Execution video records a run for inspection and is a separate feature. [Recorder setup](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/GUEST_RECORDER.md) · [Demo videos](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/DEMOS.md)

## Before creating a Windows VM

You must obtain a Windows 11 installation ISO and a valid license yourself, and complete activation yourself. VAMP includes no Windows ISO, product key or license and provides no activation bypass.

Initial unattended profiles target detected Debian amd64 and Windows 11 x64 media. The public sandbox account is `vboxuser` / `password123!`; the guest administrator/root password may be the same. These credentials do not grant a Windows license. Guest recorder setup requires guest internet access.

`installation_started` means the installer was launched. OS and recorder installation completion still need checking. Failed provisioning leaves partial VMs and disks for inspection. [Guest preparation](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/GUEST_AUTOMATION.md)

## Settings

| Setting | Purpose |
| --- | --- |
| `vamp.pythonExecutable` | Optional Python for creating the host venv. |
| `vamp.vboxManagePath` | Optional VBoxManage executable path. |
| `vamp.mousePythonExecutable` | Host Python with matching VirtualBox SDK bindings. |

## Current state

Built in one day with Codex through vibe coding. It is an early prototype with missing features and rough edges. So far, KVM/SPICE and VirtualBox are the only virtualization paths tried. Hyper-V is experimental and untested. Token savings have not been measured.

Tests cover an Ubuntu host with existing Windows 11/Debian 13 guests, and Windows-host MCP processes with a nested diskless EFI VM. Fresh OS installation completion, snapshot restore and physical Windows/macOS hardware remain unverified. Initial unattended profiles do not support ARM guests. [Validation record](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/VALIDATION.md)

YOLO/PaddleOCR and SPICE/Hyper-V are not bundled in this extension. VAMP implements no telemetry; the MCP client controls which tool results it sends to a model provider.

## License

Original integration: MIT. Bundled [mcp-virtualbox](https://github.com/chryaner/mcp-virtualbox) code: MIT. The independent guest [PyAutoGUI-Recorder](https://github.com/axel-magard/PyAutoGUI-Recorder): GPL-3.0, with source and license included. VirtualBox and optional models retain their own licenses. [Third-party notices](https://github.com/wayfarer6/vamp-mcp/blob/main/THIRD_PARTY_NOTICES.md)
