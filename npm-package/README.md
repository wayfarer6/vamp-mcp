# VAMP MCP

Independent stdio MCP servers for VM-isolated GUI automation. Run with an MCP client such as VS Code or Codex; the VS Code extension is optional for these servers.

## Requirements and scope

- Node.js 22+.
- Local VirtualBox tools need VirtualBox 7.x. Python helper tools need Python 3.11+; set `RPA_HOST_PYTHON` to your Python executable. Install Robot Framework, pycdlib, asyncvnc or the matching VirtualBox Python SDK when the chosen operation requires them.
- The `remote` server runs on the host owning KVM/libvirt or VirtualBox. To operate a different machine, start it there over SSH. Linux KVM requires access to `virsh` and the selected libvirt URI. VM creation also needs `virt-install` and `qemu-img`. Debian automatic installation boots the stock ISO and injects a preseed into the initrd; `xorriso` is not used. Guest setup is served over HTTP from a host Python 3 server on port 8421.
- Provide your own VMs, guest operating systems, licenses and Guest Additions when needed. Package installation does not create VMs or install system dependencies.
- VAMP Vault MCP is a separate npm package, `vamp-mcp-vault`. The live viewer and graphical manager require the VS Code extensions; npm does not install them. Hyper-V is not included in this npm release.
- Full SPICE/OCR/YOLO workflows still require the source repository and their documented environments.

## Install and run

```sh
npm install -g vamp-mcp
vamp-mcp --help
```

Or run without a global install:

```sh
npx -y vamp-mcp@0.2.0 virtualbox
npx -y vamp-mcp@0.2.0 kvm
npx -y vamp-mcp@0.2.0 library
npx -y vamp-mcp@0.2.0 remote --backend kvm
```

Servers communicate over standard input/output and wait for an MCP client. Use separate MCP registrations for each server. Installation alone does not register them with every client.

## VS Code MCP configuration

Add a server to `.vscode/mcp.json` (on Windows use `npx.cmd` if your client requires it):

```json
{
  "servers": {
    "vamp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "vamp-mcp@0.2.0", "virtualbox"],
      "env": {"RPA_HOST_PYTHON": "/absolute/path/to/python"}
    }
  }
}
```

Replace the Python path with an existing executable on your host.

## Codex MCP configuration

In `~/.codex/config.toml`:

```toml
[mcp_servers.vamp]
command = "npx"
args = ["-y", "vamp-mcp@0.2.0", "virtualbox"]

[mcp_servers.vamp.env]
RPA_HOST_PYTHON = "/absolute/path/to/python"
```

For KVM, change the final argument from `virtualbox` to `kvm`. This uses the existing host controller: inventory, VM creation, start/stop, screenshots, keyboard/mouse and saved RPA replay. It does not provide the full source-repository SPICE/OCR environment or a live viewer.

For the RPA library, register `library` instead and set `VAMP_RPA_REGISTRY` to your saved VAMP catalog directory. Its default is `~/.vamp/rpa-catalog`; an existing VS Code catalog must be selected explicitly. The library searches and replays reviewed definitions; it does not provide the extension's authoring UI. Replay needs its Python dependencies and a reviewed, compatible RPA. Actions completing does not prove application success; verify the expected outcome.

## Remote host example

Install this package on the VM host, then configure an MCP client to run:

```sh
ssh -T user@vm-host vamp-mcp remote --backend kvm
```

The remote shell must find `vamp-mcp` and Node on its PATH. Specify their installed absolute paths if necessary. Prefer SSH keys and your existing SSH configuration; do not put passwords in MCP configuration.

## Build and verify from source

From the repository root, prepare the existing runtime build dependencies:

```sh
npm ci --prefix third_party/mcp-virtualbox --ignore-scripts
npm run build --prefix third_party/mcp-virtualbox
npm ci --prefix vscode-extension --ignore-scripts
npm run build --prefix npm-package
npm pack ./npm-package --pack-destination /tmp
VAMP_TEST_TARBALL=/tmp/vamp-mcp-0.2.0.tgz npm test --prefix npm-package
```

The build reuses the VSIX runtime bundling and dependency license notices. The published package has no install scripts and no npm runtime dependencies; JavaScript dependencies are bundled. See the repository for backend-specific setup and validation limits.

[Source and documentation](https://github.com/wayfarer6/vamp-mcp)

## VM creation and installation

For KVM, call `remote_vm_create` with `name`, an absolute host `iso_path`, `guest_os:"debian"`, and `confirmed:true` after user authorization. Debian amd64 installer ISOs default to unattended installation; use `installation_mode:"manual"` to opt out. Ubuntu/Windows installation is manual; Windows additionally requires `windows_confirmed:true` and your own valid license.

For VirtualBox, use `vm_create`. Compatible ISOs use VirtualBox unattended installation; when VirtualBox reports the ISO as unsupported, the stock installer runs and you complete it manually. VAMP never rewrites the ISO and does not use `xorriso`. The post-install hook downloads the guest setup from the host HTTP server on port 8421 (`vm_script_server_start`, `vm_script_server_stop`, `vm_script_server_status`), and `vm_guest_bootstrap` serves and types the wget/`irm` command.

Automatic Debian installation uses the **public sandbox account `vboxuser` / `password123!`**. Change it before using the VM for private work. The source ISO and existing VMs are never overwritten; the stock ISO is attached or read as-is. Guest setup scripts are staged into a per-user state folder and served read-only on port 8421 (no directory listing, 30-minute default TTL). Unsupported installer layouts fail with an error; they do not silently count as successful installation.

`startup_verified:true` confirms Running state only. Verify OS installation and the guest desktop separately. Recorder/Vault guest setup is not automatically completed by this Debian path. The full repository's richer lab installers remain separate workflows.

On Linux, stop active VirtualBox VMs before starting KVM and vice versa. Concurrent use can crash VirtualBox with `VERR_SVM_IN_USE`; creation/start paths check for the other hypervisor.

한국어: `vamp-mcp` 하나에서 VirtualBox와 KVM을 선택합니다. KVM의 `remote_vm_create`는 명시적 확인 후 VM을 생성·기동하며, Debian amd64 설치 ISO는 순정 ISO 부팅과 preseed 커널 주입으로 자동 설치합니다(xorriso 불필요). Python·virt-install·qemu-img를 호스트에 준비하세요. 게스트 설정 스크립트는 파이썬 HTTP 서버가 8421 포트로 제공하고 게스트가 wget/curl로 내려받습니다. 공개 테스트 계정은 `vboxuser` / `password123!`입니다. VM 기동 성공과 OS·게스트 도구 설치 완료는 별도로 검증해야 합니다. Linux에서는 KVM과 VirtualBox VM을 동시에 실행하지 마세요.
