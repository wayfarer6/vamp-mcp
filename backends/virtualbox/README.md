# VirtualBox MCP and Robot automation

This backend exposes VirtualBox screenshots, keyboard/mouse input, VM lifecycle and recorder tools to VS Code and other MCP clients. It reuses the pinned [mcp-virtualbox](https://github.com/chryaner/mcp-virtualbox) screen/input implementation. Ordinary control does not require a guest automation agent or guest SSH.

## Host setup

Install VirtualBox 7.x, Node.js 22+ and Python 3.11+ on the host. VAMP supports VirtualBox on Windows and Linux. Current unattended amd64 installer profiles require an x64 host. Hyper-V is Windows-only and KVM is Linux-only.

```bash
python3 -m venv .venv-virtualbox
.venv-virtualbox/bin/python -m pip install -r backends/virtualbox/requirements.txt
cd third_party/mcp-virtualbox
npm ci --ignore-scripts
npm run build
```

On Windows use `python -m venv .venv-virtualbox` and `.venv-virtualbox\Scripts\python.exe`. Keep Node and VBoxManage on PATH, or set `VBOXMANAGE_PATH` to the executable's absolute path. Mouse input additionally requires the VirtualBox SDK host Python bindings (`vboxapi`) and the VM's USB Tablet setting. Set `PYTHON_PATH` to the Python executable that imports those bindings. Keyboard input and screenshots do not need the mouse SDK. Shared folders and guest recording imports require Guest Additions support.

## Observe and control

```bash
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_list
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_start --args '{"vm":"Example-Desktop"}'
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_screen_info --args '{"vm":"Example-Desktop"}'
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_screenshot --args '{"vm":"Example-Desktop"}' --screenshot artifacts/virtualbox/screen.png
```

Startup defaults to `VBoxManage startvm <VM> --type separate`. Open the running VM with VirtualBox Manager's Show action. Close its observation window using the detach/continue-in-background action to keep automation running. Do not choose shutdown, power off or save state when continued execution is required. Initial visibility and labels vary by host/version. Closing a window or finishing a Robot task does not automatically stop the VM.

Coordinates refer to the guest framebuffer, not the host observation window. Moving the observation window does not change guest coordinates. Avoid concurrent manual input. Verify **1920×1080 at 100% guest scaling** before coordinate-based automation. See the [Linux and Windows resolution guide](../../vscode-extension/RESOLUTION.md). Tool completion proves input delivery, not application success. Multilingual input depends on the guest keyboard layout and IME.

Use Python dictionaries or Robot libraries if shell JSON quoting is inconvenient. Never put private passwords in CLI arguments. Screenshots can use the existing [background YOLO/OCR pipeline](../../docs/MODEL_BACKGROUND.md). VirtualBox RPAs live in `backends/virtualbox/rpas/<id>/`; do not mix their manifests with the root SPICE runner. See [workflows](../../docs/WORKFLOWS.md) and [execution history](../../docs/EXECUTION_HISTORY.md).

## MCP connection

Replace the absolute path below. Run Node directly so npm output cannot contaminate the MCP protocol.

```json
{"mcpServers":{"virtualbox-rpa":{"command":"node","args":["/absolute/path/vamp-mcp/backends/virtualbox/server.mjs"],"env":{"VBOXMANAGE_DEBUG":"false"}}}}
```

Use client tool discovery for current schemas. Direct screenshot tools return MCP image content; the Python CLI saves images instead of dumping base64 into JSON. Model workers remain separate from lightweight clients. Review [validation records](../../docs/VALIDATION.md) for tested scope; Hyper-V guest execution remains unverified.

## Create from an ISO

```bash
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_create --args '{"iso_path":"/absolute/path/debian-amd64.iso"}'
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_create --args '{"iso_path":"/absolute/path/Win11.iso","name":"Example-Windows11","memory_mb":8192,"image_index":1}'
```

Use an ISO path on the VirtualBox host. Compatible Debian amd64 and Windows 11 x64 installation continues without AI after the initial request. Debian installs GNOME from the shared preseed profile. Guest setup downloads from the host HTTP server on port 8421. Windows uses an encoded post-install command that survives batch logging and runs recorder setup at first desktop login.

The public sandbox account is `vboxuser` / `password123!`; the same password may apply to Linux root or Windows administrator. Supply your own Windows ISO, valid license and activation. Some ISOs need an edition index or product key. Existing VM names/directories are not overwritten. Failures preserve `vamp-install.json` and partial resources for inspection. Client cancellation may leave a VM that has already started. Creation reports installation progress separately from verified OS/recorder completion.

Finish setup before locking or suspending the guest. Setup disables automatic idle sleep and screen locking. If setup does not run, use the returned recovery command inside the guest. Display resolution is best effort; verify it independently. See [guest automation](../../docs/GUEST_AUTOMATION.md), [recorder setup](../../docs/GUEST_RECORDER.md) and [display settings](../../docs/VM_DISPLAY.md).

## Reusable UI skills

The release skills ZIP and VSIX/npm `runtime/skills` include `vamp-ui-cleanup`, `vamp-ui-validation` and `vamp-rpa-ui-checks`. Copy individual folders into your agent's skills directory. The RPA UI skill includes AI display preflight instructions. These are reusable workflows, not background automation or replacements for hypervisor adapters.

## Attribution

Upstream: **chryaner/mcp-virtualbox**, revision `b51349126d34824cb211d412fc815f1e2e4ed2a5`, MIT, Copyright (c) 2026 mcp-virtualbox contributors. Preserve the [upstream license](../../third_party/mcp-virtualbox/LICENSE); [PROVENANCE.json](../../third_party/mcp-virtualbox/PROVENANCE.json) records source hashes and local changes. Combined project code uses the root MIT license. VirtualBox, its SDK/Extension Pack and YOLO models retain their own licensing terms. Hypervisor/Extension Pack binaries are not bundled. See [third-party notices](../../THIRD_PARTY_NOTICES.md).
