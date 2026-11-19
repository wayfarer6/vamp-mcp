# VAMP MCP

A unified stdio MCP server for virtual machines, RPA and Podman containers. Run with an MCP client such as VS Code or Codex; the VS Code extension is optional for these servers.

## Requirements and scope

- Node.js 22+.
- Local VirtualBox tools need VirtualBox 7.x. Python helper tools need Python 3.11+; set `RPA_HOST_PYTHON` to your Python executable. Install Robot Framework, pycdlib, asyncvnc or the matching VirtualBox Python SDK when the chosen operation requires them.
- The `remote` server runs on the host owning KVM/libvirt or VirtualBox. To operate a different machine, start it there over SSH. Linux KVM requires access to `virsh` and the selected libvirt URI. VM creation also needs `virt-install` and `qemu-img`. Debian automatic installation boots the stock ISO and injects a preseed into the initrd; `xorriso` is not used. Guest setup is served over HTTP from a host Python 3 server on port 8421.
- Provide your own VMs, guest operating systems, licenses and Guest Additions when needed. Package installation does not create VMs or install system dependencies.
- VAMP Vault MCP is a separate npm package, `vamp-mcp-vault`. The live viewer and graphical manager require the VS Code extensions; npm does not install them. Hyper-V is not included in this npm release.
- Full SPICE/OCR/YOLO workflows still require the source repository and their documented environments.

## Install and run

Download `vamp-mcp-0.3.7.tgz` and `SHA256SUMS` from the [GitHub release](https://github.com/wayfarer6/vamp-mcp/releases/tag/v0.3.7). Compare the archive's SHA-256 with the corresponding release entry before installing it.

```sh
npm install -g ./vamp-mcp-0.3.7.tgz
vamp-mcp --version
```

The public npm registry's `latest` tag points to an older release. See the [GitHub advisory](https://github.com/advisories/GHSA-q37r-5xxr-6v4x) for the affected historical npm versions.

The current default entry point is `vamp-mcp` with no arguments (or `vamp-mcp unified`). Register it once as **VAMP MCP**. Register `vamp-mcp-vault` separately only if you use Vault. The per-backend subcommands remain available for explicit legacy integrations; do not add them as duplicate registrations.

## Default MCP registration

Register a verified installed binary rather than relying on an implicit download. A VS Code client with both VAMP extensions does not need additional manual entries. Remove manually added legacy entries after updating both extensions. See the [registration and migration guide](https://github.com/wayfarer6/vamp-mcp/blob/main/docs/MCP_REGISTRATION.md).

```json
{
  "servers": {
    "vamp": { "type": "stdio", "command": "vamp-mcp", "args": [] },
    "vamp-vault": { "type": "stdio", "command": "vamp-mcp-vault", "args": [] }
  }
}
```

Omit the Vault entry if you do not use it. Where required, replace commands with the absolute paths of the two verified installed binaries. The examples below are legacy integrations, not additional entries to enable alongside these two.

## Legacy VS Code MCP configuration

Add a server to `.vscode/mcp.json` (on Windows use the installed `vamp-mcp.cmd` path if your client requires it):

```json
{
  "servers": {
    "vamp": {
      "type": "stdio",
      "command": "vamp-mcp",
      "args": ["virtualbox"],
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
command = "vamp-mcp"
args = ["virtualbox"]

[mcp_servers.vamp.env]
RPA_HOST_PYTHON = "/absolute/path/to/python"
```

For KVM, change the final argument from `virtualbox` to `kvm`. This uses the existing host controller: inventory, VM creation, start/stop, screenshots, keyboard/mouse and saved RPA replay. It does not provide the full source-repository SPICE/OCR environment or a live viewer.

For the RPA library, register `library` instead and set `VAMP_RPA_REGISTRY` to your saved VAMP catalog directory. Its default is `~/.vamp/rpa-catalog`; an existing VS Code catalog must be selected explicitly. The library searches and replays reviewed definitions; it does not provide the extension's authoring UI. Replay needs its Python dependencies and a reviewed, compatible RPA. Actions completing does not prove application success; verify the expected outcome.

## Podman containers

The `podman_*` tools in **VAMP MCP** manage **existing containers** over an explicitly chosen, named rootless SSH connection. To use these tools, register the installed `vamp-mcp` binary once with no arguments, or enable **VAMP MCP** in VS Code. **Open Containers** remains available separately as a graphical view.

Install the Podman CLI in a standard location on the machine running VAMP, and run a rootless Podman service on the Debian VM or Linux server. Configure the named SSH connection in Podman with an absolute local identity path before using VAMP. Podman Desktop is optional. VAMP does not enable WSL or Hyper-V, create a VM, install Podman, or change the default Podman connection. A VirtualBox guest needs only its existing hypervisor and an SSH route such as host-only networking or localhost NAT port forwarding.

Use a dedicated, least-privileged remote account and SSH host verification. Do not expose the Podman socket on unauthenticated TCP or give its credentials to containers. For operation and troubleshooting, see the bundled `runtime/skills/vamp-podman/SKILL.md`. Users opting into WSL can follow the separate manual guide at `runtime/skills/vamp-podman/CONTAINERS_WSL.md`.

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
VAMP_TEST_TARBALL=/tmp/vamp-mcp-0.3.7.tgz npm test --prefix npm-package
```

The build reuses the VSIX runtime bundling and dependency license notices. The published package has no install scripts and no npm runtime dependencies; JavaScript dependencies are bundled. See the repository for backend-specific setup and validation limits.

[Source and documentation](https://github.com/wayfarer6/vamp-mcp)

## VM creation and installation

For KVM, call `remote_vm_create` with `name`, an absolute host `iso_path`, `guest_os:"debian"`, and `confirmed:true` after user authorization. Debian amd64 installer ISOs default to unattended installation; use `installation_mode:"manual"` to opt out. Ubuntu/Windows installation is manual; Windows additionally requires `windows_confirmed:true` and your own valid license.

For VirtualBox, use `vm_create`. Compatible ISOs use VirtualBox unattended installation; when VirtualBox reports the ISO as unsupported, the stock installer runs and you complete it manually. VAMP never rewrites the ISO and does not use `xorriso`. The post-install hook downloads the guest setup from the host HTTP server on port 8421 (`vm_script_server_start`, `vm_script_server_stop`, `vm_script_server_status`), and `vm_guest_bootstrap` serves and types the wget/`irm` command.

Automatic Debian installation uses the **public sandbox account `vboxuser` / `password123!`**. Change it before using the VM for private work. The source ISO and existing VMs are never overwritten; the stock ISO is attached or read as-is. Guest setup scripts are staged into a per-user state folder and served read-only on port 8421 (no directory listing, 30-minute default TTL). Unsupported installer layouts fail with an error; they do not silently count as successful installation.

`startup_verified:true` confirms Running state only. Verify OS installation and the guest desktop separately. Recorder/Vault guest setup is not automatically completed by this Debian path. The full repository's richer lab installers remain separate workflows.

On Linux, stop active VirtualBox VMs before starting KVM and vice versa. Concurrent use can crash VirtualBox with `VERR_SVM_IN_USE`; creation/start paths check for the other hypervisor.


## VM installation with HashiCorp Packer

VAMP uses **HashiCorp Packer** to automate new VM installation and post-install setup. Prepare Environment downloads the pinned Packer CLI for Windows x64, Linux x64/ARM64 or macOS Intel/Apple Silicon, verifies its SHA-256, and installs the selected official plugin with `packer init`: VirtualBox, Hyper-V or QEMU (KVM). The hypervisor itself remains a host prerequisite. Windows ARM64 has no pinned native Packer binary; current guest templates require an x64 host and Debian amd64 or Windows 11 x64 media. macOS hosts use VirtualBox; an Apple Hypervisor adapter is not implemented.

The shared installer flow boots your original ISO with the backend's Packer builder, configures the OS, reboots and waits **60 seconds** before desktop post-install setup. Debian GNOME automatically logs into the public sandbox account `vboxuser` / `password123!`; Windows uses the same public sandbox account for first-login setup and still requires your own valid license. Use these defaults only for an authorized sandbox. The guest reports successful post-install setup to a per-build token endpoint before shutting down for golden-image export. No persistent SSH/WinRM communicator is installed by Packer. Resolution still requires fresh framebuffer verification.

VirtualBox is the reference profile. Hyper-V changes generation/switch/TPM settings; KVM changes QEMU acceleration, disk, firmware and network settings. These profiles share installation and post-install scripts. A successful `packer validate` is not proof of a complete guest installation. Check each image's build status and `packer.log`; failed partial builds are preserved. Hyper-V requires Windows permissions and the Default Switch; KVM requires Linux, QEMU/libvirt, virt-install and OVMF, plus swtpm for Windows. Windows answer media is generated automatically by an isolated, pinned pycdlib helper (installed on first use); no ADK/xorriso installation is needed. VAMP creates a separate answer-media ISO; your installation ISO is not rewritten. Allow guest access to the setup server on TCP 8421 and the per-build Packer HTTP/completion ports.

VSIX and MCP use the same Packer runner. VM creation returns a queued build, not a completed VM. The live VM is deployed after OS installation, post-install confirmation and export succeed. In VM Manager, **Golden images** shows build status, absolute folder and image-file paths, byte sizes, and logs. Use **Open folder** or **Delete golden image**. Deletion asks for confirmation and is disabled while a build is active.

Storage defaults to `~/.vamp` (`%USERPROFILE%\.vamp` on Windows), overridable with `VAMP_HOME`:

- `tools/packer/`: downloaded CLI, official plugins and cache.
- `golden/<image-id>/artifact/`: golden OVA/QCOW2/Hyper-V export; builds can consume many GB.
- `golden/<image-id>/packer.log` and `image.json`: build evidence and status.
- `vms/<backend>/<name>/`: separately deployed live VM disks. Deleting a golden image does not delete these disks.

MCP exposes `vm_packer_prepare`, `vm_create`, `vm_golden_images` and `vm_golden_image_delete`; the remote host server exposes corresponding `remote_*` tools. Inspect the image ID, path and size before explicitly confirming deletion. Remote paths are on the host running that MCP server.

Manual preparation (Python 3.11+):

```sh
python backends/packer/runner.py prepare --backend virtualbox
python backends/packer/runner.py images
```

Packer and its plugins are downloaded separately under their own licenses; they are not bundled as VAMP code. Official documentation: [Packer installation](https://developer.hashicorp.com/packer/install), [plugin initialization](https://developer.hashicorp.com/packer/docs/commands/init), [VirtualBox](https://developer.hashicorp.com/packer/integrations/hashicorp/virtualbox), [Hyper-V](https://developer.hashicorp.com/packer/integrations/hashicorp/hyperv), [QEMU](https://developer.hashicorp.com/packer/integrations/hashicorp/qemu).

Guest resolution reset shortcuts are installed during setup: **Windows Desktop:** double-click `Set-Resolution-1920x1080.cmd` (companion `Set-Resolution-1920x1080.ps1`); **Debian home:** run `~/set-resolution-1920x1080.sh` in the guest terminal. All usage text is in English. These shortcuts apply Full HD to the guest and report failure if the display driver cannot provide it.

Windows guest setup and display-reset scripts request administrator PowerShell when needed. Approve the UAC prompt. The elevated process runs `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force` before the script. MCP and VSIX share the same Ctrl+Shift+Enter / UAC Left+Enter bootstrap. Script execution policy changes apply to that process.

Windows guest setup now installs **VirtualBox Guest Additions** from matching vendor media, or downloads the official **virtio-win** ISO for KVM and installs the signed guest driver packages (and QEMU guest agent when provided). A privileged scheduled task resumes setup after the driver reboot, waits 60 seconds and applies Full HD before reporting completion. Packer does not treat the initial OS install or a requested reboot as completed setup. Driver media is stored in the managed tool cache; binaries retain their vendor licenses and are downloaded separately.

Ubuntu KVM profiles read the host's osinfo-db XML, then use `virt-install --dry-run --print-xml` to resolve virt-manager hardware defaults. Install `osinfo-db`, `libosinfo-bin`, `virtinst`, `qemu-system-x86`, `qemu-utils`, `ovmf` and `swtpm`. The generated `osinfo-profile.json` and `virt-manager-profile.xml` are preserved beside each Packer build. Builds use QEMU user NAT; deployed guests use user networking for `qemu:///session` or the existing `default` network/storage pool for `qemu:///system`. KVM and Hyper-V hardware testing is left to the user for this release.

Windows setup finishes with an elevated direct registry update to 1920x1080 (`PrimSurfSize.cx/cy` and `ActiveSize.cx/cy`) for the guest display configurations, on VirtualBox, KVM and Hyper-V. The Desktop reset script performs the same update before applying the display mode. Previous registry values are backed up under `%ProgramData%\VAMP\display-registry\backups`. A compatible guest display driver is still required.

Debian setup pins the connected DRM output to `1920x1080@60D` using a managed GRUB drop-in and `update-grub`. After automatic GNOME login, it persistently selects Full HD at scale 1 and distributes `monitors.xml` to the desktop users, GDM/GDM3, `/etc/xdg` and `/etc/skel`. Boot services restore these settings. GDM automatically logs in as `vboxuser`; system dconf policy disables idle blanking, dimming, automatic lock and idle sleep, while systemd sleep targets are masked. The first desktop finalization waits 60 seconds.

## Building a provisioning asset candidate

Run `npm pack --pack-destination <package-output-directory>` from this directory.
The build prints the path to its versioned provisioning archive and
`SHA256SUMS`. Set `VAMP_RELEASE_ASSETS_OUTPUT` to a new absolute directory
to choose where they are written. The npm runtime contains JavaScript and
the JSON metadata it reads directly. Python, shell scripts, templates, skills
and other operational assets live in the archive. RPA search and details use
the local registry.

Publish the archive as `vamp-assets-v<version>.tar.gz` on the matching GitHub
release before distributing the exact npm tarball from that same build.
To verify the pair before publishing, run `npm test` with
`VAMP_TEST_TARBALL` set to the npm tarball and `VAMP_TEST_ASSETS_OUTPUT`
set to the archive directory. The test installs the package and checks
its pinned digest, the archive contents, and offline cache installation.
The first operation that needs
the Packer runner, guest script server start, or recorder media request installs it in
`~/.vamp/assets/v<version>` (override the cache root with `VAMP_ASSETS_DIR`).
For an offline machine, copy the archive over and run
`vamp-mcp assets install <archive>`. The command verifies the archive against
the digest embedded in the npm package. You can also pass the release digest
as a second argument to check it against the embedded value.
Package installation and MCP discovery require no provisioning download.
Script-server status and stop use an existing cache or configured local
script path and never fetch an archive.
