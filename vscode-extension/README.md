<p align="center">

  <img src="https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/vscode-extension/icon.png" width="128" height="128" alt="VAMP bat and virtual machine icon">
</p>

**Includes VAMP Vault:** Marketplace installation includes the Vault extension. When upgrading from `wayfarer6.vamp-mcp`, first update Vault to 0.1.6+, remove the legacy extension, and reload VS Code to avoid duplicate command registrations.

**Vault 함께 설치:** 마켓에서 VAMP를 설치하면 Vault도 함께 설치됩니다. 구 확장 `wayfarer6.vamp-mcp`에서 이전할 때는 Vault를 0.1.6 이상으로 업데이트한 뒤 구 확장을 제거하고 VS Code를 다시 로드하세요.


# VAMP · Virtual Agent Machine Platform

**Local & remote (SSH) hypervisors with VM-isolated GUI RPA & screenshot control for AI agents**

Record a GUI task once, turn the reviewed actions into a reusable RPA, and let an AI agent call it again by name and inputs. VAMP is being built to reduce the tokens spent repeatedly inspecting screens and reconstructing the same GUI workflow.

Opening the Naver login page is one example: launch a browser, navigate to the page and check that the expected form appeared. The reusable workflow keeps those steps and checks in local Robot/Python code. The agent can read the result summary first, then inspect logs or screenshots when needed.

This VS Code extension provides the VirtualBox MCP tools. Recording conversion, SPICE execution and local OCR/UI recognition are separate parts of the repository. Arbitrary CUA recordings cannot be imported automatically, and the AST converter emits Robot/SPICE packages; RPA Library device replay separately supports KVM and VirtualBox.

[Workflow example](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/WORKFLOWS.md) · [Documentation](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/README.md) · [Releases](https://github.com/wayfarer6/vamp-mcp/releases)

## Get started

Open the **VAMP** bat icon in the activity bar. **RPA Library** is the main entry for finding, creating and exporting reusable workflows; **Open VM Manager** manages your virtual desktops; **Browse Credentials** opens the encrypted vault.

1. **VM Manager**: select VirtualBox, KVM or Hyper-V, choose your ISO, then **Create and Start**. VirtualBox and KVM show the guest in the editor. Hyper-V embedded viewing is unsupported; use VMConnect.
2. Record a task in the guest and save the Python recording to its host share, or use **Add RPA Folder** for the host folder containing it.
3. **RPA Library → Create**: choose the recording and enter its name, description, use case, tags, inputs and expected result. **Create with AI** asks you questions and fills those fields from your answers. You review and save them.
4. Find the workflow by title or description, inspect its source, edit its review state or choose **Export ZIP**.
5. Enable **VAMP RPA Library** in VS Code MCP management. Its `rpa_search`, `rpa_details` and `rpa_run_saved` tools let agents find and reuse reviewed skills before spending tokens on another CUA/multimodal loop.

**[Full click-by-click user guide](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/USER_GUIDE.md)** is also bundled in the VSIX: **VAMP: Open Setup Guide**. It covers prerequisites, recording locations, Create/AI questions, export, credentials and recovery from errors.

Recorded replay currently supports VirtualBox and KVM for supported PyAutoGUI recorder actions, with an exact guest resolution match. Registration does not execute the source. Execution requires review, an explicit VM and confirmation; `completed_unverified` still needs application-result verification. VirtualBox mouse replay requires its matching Python SDK. Existing Robot packages require their matching shared runtime; ZIP exports contain source, not a standalone VM or runtime.

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
| `vamp.remote.enabled` | Show the **VAMP Remote (SSH)** server and remote view. |
| `vamp.remote.host` / `port` / `username` / `privateKeyPath` | SSH target of the machine that owns the desktops. |
| `vamp.remote.backend` | `kvm` (libvirt/`virsh`) or `virtualbox` (`VBoxManage`) on the remote host. |
| `vamp.remote.libvirtUri` | libvirt connection used on the remote host. |
| `vamp.remote.remoteNodePath` / `remotePythonPath` | Node.js 20+ and Python 3.11+ on the remote host. |
| `vamp.remote.remoteRepoPath` / `remoteRegistryPath` | Optional VAMP checkout and RPA registry on the remote host. |

## Current state

Built in one day with Codex through vibe coding. It is an early prototype with missing features and rough edges. So far, KVM/SPICE and VirtualBox are the only virtualization paths tried. Hyper-V is experimental and untested. Token savings have not been measured.

Tests cover an Ubuntu host with existing Windows 11/Debian 13 guests, and Windows-host MCP processes with a nested diskless EFI VM. Fresh OS installation completion, snapshot restore and physical Windows/macOS hardware remain unverified. Initial unattended profiles do not support ARM guests. [Validation record](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/VALIDATION.md)

YOLO/PaddleOCR and SPICE/Hyper-V are not bundled in this extension. VAMP implements no telemetry; the MCP client controls which tool results it sends to a model provider.

## License

Original integration: MIT. Bundled [mcp-virtualbox](https://github.com/chryaner/mcp-virtualbox) code: MIT. The independent guest [PyAutoGUI-Recorder](https://github.com/axel-magard/PyAutoGUI-Recorder): GPL-3.0, with source and license included. VirtualBox and optional models retain their own licenses. [Third-party notices](https://github.com/wayfarer6/vamp-mcp/blob/main/THIRD_PARTY_NOTICES.md)

## Remote desktops over SSH

Desktops can live on another machine: a home server, a lab box or a cloud VM. Set `vamp.remote.enabled`, the host and the user, then run **VAMP: Remote · Prepare Environment on the Remote Host**. The extension uploads a self-contained MCP server to `~/.vamp/remote/` there, prepares Python and libvirt/VirtualBox, and contributes the **VAMP Remote (SSH)** MCP server. Communication stays inside SSH, so no hypervisor port is opened and guest disks, credentials and the vault never leave the remote host.

Remote screens are **screenshots**, one PNG per request, with no live stream. Start/stop, list, status, key input, absolute-pointer clicks on KVM and reviewed RPA replay are available remotely. VirtualBox remote clicks and pointer movement require `--repo` and a Python runtime with the matching VirtualBox SDK. The extension automatic uploader uses a POSIX shell; native Windows SSH can use an explicit PowerShell launch command. See [docs/REMOTE_SETUP.md](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/REMOTE_SETUP.md).

## Live KVM viewer

Set `vamp.kvmRepositoryPath` to the VAMP checkout. Optionally set `vamp.kvmPythonExecutable` and `vamp.kvmConfigPath`; the defaults are `.venv` and `config/vm-mcp.json` in that checkout. Start **VAMP KVM (VNC)** in MCP server management.

Run **VAMP: Open KVM Viewer (Live VNC)** and choose a running VM. The view receives the live binary RFB stream through a local WebSocket bridge. It is view-only, scales to the panel and supports reconnecting. The table below the screen shows the VM name, host, actual VNC port and an address copy button for external viewers. The VM image, installer ISO and model weights are outside the VSIX.

The `vboxuser` / `password123!` account is assigned by the MCP server during unattended VM installation. It is a public test default, not an operating-system-provided account.

## Version 0.1.8 validation and videos

The remote stdio startup, simultaneous hotkeys and KVM tablet click dispatch are fixed. Guidance now asks agents to implement local OCR/YOLO checks and Robot assertions in new GUI RPAs, return compact results on success and inspect targeted evidence on failures. [Low-token authoring/output policy](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/LOW_TOKEN_AUTOMATION.md).

Ubuntu/KVM Windows PDF printing and nested Windows-host VirtualBox/Debian remote keyboard/mouse scenarios passed with real guest UI and local outcome checks. VM screens are fixed at **1920×1080**; Robot recordings use **2560×1440** with padding and no upscaling. Physical Windows hosts and production ERP integrations were not tested.

[Windows host remote input video](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/media/windows-remote-fhd-qhd.mp4) · [Windows Print to PDF video](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/media/remote-windows-print-pdf.mp4) · [Replay video](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/media/remote-windows-print-pdf-replay.mp4) · [Validation and reproduction](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/REMOTE_PDF_VALIDATION.md)

The complete Robot/vision demos run from the repository; the basic VSIX does not bundle the OCR/YOLO model stack or these repository-only demonstration suites. [Download v0.1.8](https://github.com/wayfarer6/vamp-mcp/releases/tag/v0.1.8).

VAMP includes VAMP Vault (`wayfarer6.vamp-vault`) in its extension pack so Marketplace installation installs both extensions.

### VM installation in 0.1.9

VirtualBox provisioning starts headless and verifies Running state. KVM VM creation is shared between the manager and the bundled **VAMP KVM Host** MCP server (`remote_vm_create`). Debian amd64 installer ISOs can install automatically using Python and xorriso; the public sandbox login is `vboxuser` / `password123!`. Ubuntu/Windows KVM installers and Hyper-V OS installation remain manual. VM startup does not establish that OS installation, recorder setup or Vault setup completed.

Linux: shut down KVM VMs before starting VirtualBox, and vice versa. The new checks explain conflicts such as `VERR_SVM_IN_USE` instead of reporting successful startup.

한국어: 생성 후 실제 기동 상태를 확인합니다. Debian amd64 자동 설치는 Python과 xorriso가 필요하며 공개 테스트 계정은 `vboxuser` / `password123!`입니다. KVM과 VirtualBox를 동시에 실행하지 마세요. OS 설치와 게스트 녹화기·Vault 설정 완료는 별도입니다.

## RPA privacy before export or upload / RPA 공유 전 경고

**Before uploading an RPA or ZIP, inspect every source file, comment, metadata field, filename, URL and image for private IDs, passwords, tokens and certificates. Replace actual values with declared inputs. AI review is not a guarantee that secrets are absent.**

**RPA나 ZIP을 업로드하기 전에 사용자가 모든 소스·주석·메타데이터·파일명·URL·이미지를 직접 확인해야 합니다. 실제 ID·비밀번호·토큰·인증서는 제거하고 입력 매개변수를 사용하세요. AI 검토만으로 민감정보가 없다고 보장할 수 없습니다.**

In VAMP 0.1.9, Export ZIP requires local screening, AI review of a structural report and a final personal-review confirmation. Original source, recorded values, filenames and metadata values are withheld from AI. Detected secrets block export. Missing AI review, cancellation or changes after review prevent archive creation. Image content is not inspected by AI; users must inspect it themselves. Review every archive again before submitting it to GitHub or Script Hub. VAMP does not upload it automatically.

0.1.9 내보내기는 원본을 AI에 보내지 않고 구조 검사 결과만 검토받습니다. AI 경고를 읽고 전체 파일을 확인한 뒤 명시적으로 승인해야 ZIP이 생성됩니다. AI 모델이 없거나 검토를 취소하면 내보낼 수 없습니다. 이미지는 사용자가 직접 확인해야 하며, 업로드 직전에도 파일 전체를 다시 검토하세요.
