# Remote desktops over SSH

VAMP was built for a machine you sit in front of. This guide covers the other
case: the desktops live on a home server, lab box or cloud VM, and you work from
your laptop, another network, or an AI agent that only has an SSH connection.

The remote host keeps its own hypervisor, guest disks, credentials and vault.
Nothing about the guest is copied to your laptop, and no hypervisor port is
opened to the network. VAMP sends MCP JSON-RPC over an SSH stdio channel and
receives **screenshots** back. There is no live screen stream in this mode, by
design: one picture per request is enough for an agent, and it keeps the remote
host free of a video server.

```
VS Code / AI agent            SSH (22, keys only)          Remote host
┌──────────────────┐   ───────────────────────────────►   ┌────────────────────────────┐
│ VAMP extension   │   exec node ~/.vamp/remote/server.mjs │ virsh / VBoxManage         │
│ (MCP client)     │   ◄───────────────────────────────    │  └─ guest VMs (screenshots)│
└──────────────────┘        MCP JSON-RPC + PNG            └────────────────────────────┘
```

## 1. What you need on the remote host

| Item | Why | Checked by |
| --- | --- | --- |
| OpenSSH server | the only transport | `ssh` on your computer |
| Node.js 20+ | runs the VAMP remote server | `remote_env_check` |
| Python 3.11+ | replays saved RPAs (optional) | `remote_env_check` |
| KVM: libvirt + `virsh` (+ `virt-install`, `qemu-img` to create desktops) | hypervisor control | `remote_env_check` |
| VirtualBox: `VBoxManage` | hypervisor control | `remote_env_check` |

The supported unattended `bootstrap`, `proxy`, and live-viewer route is Linux
KVM. The uploader checks the host OS over
SSH before writing files and reports `remote_host_unsupported_os` when it cannot
establish that the host is Linux. The extension automatic uploader expects a
POSIX shell. For the legacy native Windows VirtualBox path, run
the remote server with an explicit PowerShell SSH command; see
[the Windows lab setup](REMOTE_PDF_VALIDATION.md). WSL does not establish native
Windows VirtualBox SDK support by itself.

Run `vamp-mcp bootstrap --host lab.example --user dev` to check Node.js and
read-only libvirt access, upload the remote server, and verify that it can list
desktops. Bootstrap runs without `sudo` and assumes the host dependencies are
already installed. After that, a standalone MCP client can use
`vamp-mcp proxy --host lab.example --user dev` as its stdio command. Use
`--port`, `--key`, `--node`, or `--libvirt-uri` to match the SSH host. Verify the
host key through a trusted source and add it to OpenSSH's known-hosts file before
using the proxy, an exported MCP configuration, or its Verify action. When SSH
disconnects between requests, the proxy reconnects to the same host once and
restores the session if the handshake still matches. If a request was in flight
or the retry fails, the proxy reports `remote_session_lost` on stderr. Start a
new MCP session and check the operation's outcome before retrying it.
Initial SSH failures report `remote_unreachable`, `remote_auth_failed`, or
`remote_host_key_untrusted`. A missing remote Node command reports
`remote_node_missing`, and a failed libvirt bootstrap check reports
`remote_libvirt_unavailable`.
The Linux KVM stdio server records the time, tool name, and outcome in its
private `~/.vamp/remote/tool-audit.jsonl` file. Arguments, results, and
subprocess errors are excluded.

In desktop VS Code, **VAMP Remote: Open Live Viewer** opens a tunnel to a
noVNC/websockify service already listening on the Linux host at `127.0.0.1:6080`.
Connect once over SSH and verify the host key before opening the viewer. Closing
the viewer closes its tunnel. The VS Code status bar shows the viewer connection
state. If the connection drops, choose **Reconnect** to reopen it. The
screenshot viewer does not enable forwarding.

The viewer and script-server tunnels use the configured SSH host, port, account
and key directly. Use a reachable hostname or IP and set these connection details
explicitly if you normally get them from an SSH config alias or jump host.

If the Linux host already runs the VAMP script server on `127.0.0.1:8421`,
add `--verify-setup-server` to `vamp-mcp bootstrap` to check `/healthz` over a
temporary SSH tunnel. The check closes its tunnel before returning. This checks
host access from the client. Guest installers use their configured guest network.

KVM guests need a graphics device for screenshots and an absolute pointing
device (USB tablet) for clicks. Desktops created by VAMP already have both.

## 2. SSH keys first

VAMP never asks for a password and never stores one. `BatchMode=yes` is always
set, so a password prompt cannot hang a background agent.

```bash
# On your computer: create a key if you do not have one.
ssh-keygen -t ed25519 -C "vamp-remote"

# Copy the public key to the remote host (once, with a password).
ssh-copy-id -i ~/.ssh/id_ed25519.pub you@lab-host.local

# Prove that non-interactive login works before configuring VAMP.
ssh -T -o BatchMode=yes you@lab-host.local 'echo ok; virsh --version'
```

The first connection adds the host key to `known_hosts` (`accept-new`). If a
host key later changes without your knowledge, stop and investigate: VAMP will
refuse to continue.

Keep access off the public internet where possible. Tailscale, WireGuard or a
jump host is the usual choice:

- **Tailscale:** use the `100.x.y.z` address or the MagicDNS name as the host.
- **Only a jump host is reachable:** connect once with `ssh -J jumphost`,
  or add a `Host` block to `~/.ssh/config` and leave the VAMP key field empty so
  your SSH configuration is used.
- **Port is not 22:** set `vamp.remote.port`.

## 3. Configure VAMP

Open **Settings** and search for `vamp.remote`, or run
**VAMP: Remote · Set Host and User**, which asks for the host and user and saves
both settings.

| Setting | Default | Meaning |
| --- | --- | --- |
| `vamp.remote.enabled` | `false` | Show the remote server and manager. |
| `vamp.remote.host` | — | LAN, VPN or Tailscale host name. |
| `vamp.remote.port` | `22` | SSH port. |
| `vamp.remote.username` | — | SSH user; empty means your local user name. |
| `vamp.remote.privateKeyPath` | — | Key file, or empty to use the agent and `~/.ssh/config`. |
| `vamp.remote.backend` | `kvm` | `kvm` (libvirt/`virsh`) or `virtualbox` (`VBoxManage`). |
| `vamp.remote.libvirtUri` | `qemu:///system` | Connection used on the remote host. |
| `vamp.remote.remotePythonPath` | `python3` | Python 3.11+ for RPA replay. |
| `vamp.remote.remoteNodePath` | `node` | Node.js 20+ for the remote server. |
| `vamp.remote.remoteRepoPath` | — | VAMP checkout on the remote host; only needed for RPA replay. |
| `vamp.remote.remoteRegistryPath` | — | Saved RPA registry; defaults to `~/.vamp/remote/rpa-catalog`. |
| `vamp.remote.remoteVboxManagePath` | — | `VBoxManage` path when it is not on `PATH`. |
| `vamp.remote.connectTimeoutSeconds` | `10` | How long to wait for SSH. |

## 4. Prepare the remote environment

Run **VAMP: Remote · Prepare Environment on the Remote Host** (or press
**Prepare remote environment** in the VM Manager's Remote view). It:

1. checks the SSH connection;
2. uploads the remote server to `~/.vamp/remote/server.mjs` (mode `600`) and the
   setup script beside it;
3. runs `remote_env_check` and prints every result to the VAMP output channel;
4. runs `remote_env_setup`: creates `~/.vamp/remote`, a Python venv, installs
   `requirements-mcp.txt` when a repository is configured, and — with
   passwordless sudo — installs libvirt/QEMU packages, enables `libvirtd` and
   adds your user to the `libvirt` group;
5. verifies again and reports what is still missing.

Steps that need an administrator are reported with the exact command instead of
failing silently. Nothing is removed: no VM, disk image, registry or setting is
deleted by setup.

Without passwordless sudo, run the printed command yourself:

```bash
sudo apt-get install -y qemu-kvm libvirt-daemon-system libvirt-clients virtinst qemu-utils
sudo systemctl enable --now libvirtd
sudo usermod -aG libvirt "$USER"   # then log out and back in
```

The same work is available as a shell script for terminal use:

```bash
scripts/remote_host_setup.sh --backend kvm --repo ~/vamp-mcp --dry-run
scripts/remote_host_setup.sh --backend kvm --repo ~/vamp-mcp
```

## 5. Use it

**VM Manager → Remote server · SSH**

- **Save connection** stores host, port, user, key, hypervisor and libvirt URI.
- **Verify environment** runs the read-only checks.
- **Prepare remote environment** does the setup above.
- Desktops on the remote host appear in the machine list. **Start** and
  **Shut Down** act on the remote hypervisor; **Screenshot** opens a view-only
  window that refreshes every few seconds.
- Desktops are created on the remote host itself, not from this window. Deletion
  is deliberately not offered over the MCP channel.

**Commands**

| Command | Purpose |
| --- | --- |
| `VAMP: Remote · Set Host and User` | Quick configuration. |
| `VAMP: Remote · Prepare Environment on the Remote Host` | Upload + setup. |
| `VAMP: Remote · Verify Remote Environment` | Read-only checks. |
| `VAMP: Remote · List Desktops` | List VMs with state, memory and CPUs. |
| `VAMP: Remote · Capture Desktop Screenshot` | Save a PNG of a running guest. |
| `VAMP: Open Remote Desktop Manager (SSH)` | Open the manager on the remote view. |

## 6. Connect an AI agent

With `vamp.remote.enabled` and a host set, the extension contributes the MCP
server **VAMP Remote (SSH)**; VS Code starts `ssh` itself, so agents see the
remote tools next to the local ones.

For Claude Desktop or Cursor, run **VAMP Remote: Export MCP Config** in VS Code
and save the JSON to a new file. Choose **Verify** to check MCP initialization
and see the remote tool count. Add the exported `mcpServers.vamp-remote` entry to
the client's configuration under `mcpServers`. If that name is already used,
choose an unused name for the new entry.

To use the standalone VAMP proxy with a Linux KVM host, register this command
after running `vamp-mcp bootstrap`. Replace the example host and account:

```json
{
  "mcpServers": {
    "vamp-remote": {
      "command": "vamp-mcp",
      "args": ["proxy", "--host", "lab-host.local", "--user", "you"]
    }
  }
}
```

The remote server exposes:

| Tool | Read-only | What it does |
| --- | --- | --- |
| `remote_env_check` | yes | Node, Python, libvirt/VirtualBox, repository, disk space; lists blockers with fixes. |
| `remote_env_setup` | no | Create work directory/venv, install hypervisor packages when sudo allows, verify connection. `dry_run` lists commands. |
| `remote_vm_list` | yes | Desktops with state, memory and CPUs. |
| `remote_vm_status` | yes | One VM in detail: disks, graphics endpoint, network, autostart. |
| `remote_vm_start` | no | Start a desktop headless. |
| `remote_vm_stop` | no | Graceful guest shutdown; `force` powers off. |
| `remote_vm_screenshot` | yes | PNG of the guest screen, returned as image data. |
| `remote_vm_send_keys` | no | Type text, sequential `keys`, or simultaneous `hotkey` chords (US layout). |
| `remote_vm_mouse_move` | no | Move the guest pointer without clicking (VirtualBox needs repository and matching Python SDK). |
| `remote_vm_mouse_click` | no | Click at fractions of the screen (KVM absolute pointer; VirtualBox with matching Python SDK and repository). |
| `remote_rpa_run` | no | Replay a reviewed saved RPA with `confirmed=true`. |

Notes for agents:

- A started VM is not a booted guest. Take a screenshot and read it.
- Screenshot coordinates stay valid because clicks use fractions, not pixels.
- Input is delivered to the guest device; the application may still ignore it.
- Guest passwords stay in the remote vault. Do not paste them into tool output.

## 7. Run the server by hand

The server is a single dependency-free ES module, so it can also be used
directly on the host:

```bash
node ~/.vamp/remote/server.mjs --help
node ~/.vamp/remote/server.mjs --tools
node ~/.vamp/remote/server.mjs --backend kvm --call remote_vm_list
node ~/.vamp/remote/server.mjs --backend kvm --call remote_vm_screenshot --args '{"vm":"lab-desktop"}'
```

Configuration can also come from `VAMP_REMOTE_BACKEND`, `VAMP_LIBVIRT_URI`,
`VAMP_REMOTE_PYTHON`, `VAMP_REMOTE_REPO`, `VAMP_RPA_REGISTRY`,
`VBOXMANAGE_PATH` and `VAMP_REMOTE_WORKDIR`.

## 8. Troubleshooting

| Symptom | Cause and next step |
| --- | --- |
| `SSH authentication failed` | Key not installed for that user, or wrong user. Test with `ssh -T` first. |
| `The remote host key is not trusted yet` | Connect once from a terminal, or remove the stale key from `known_hosts`. |
| `Nothing is listening on host:22` | SSH server down, wrong port, or firewall/VPN route. |
| `libvirt is not reachable` | `libvirtd` not running, or your user lacks `libvirt` group membership (requires a new session). |
| `Screenshot failed` | Guest is not running, or it has no graphics device. |
| `remote_vm_mouse_click` returns `unsupported` | Configure `--repo` and `--python` with the matching VirtualBox SDK; otherwise use keyboard navigation. |
| `The remote server could not start` | Node.js missing on the remote host, or the uploaded file is incomplete; run Prepare Environment again. |
| Clicks land in the wrong place | The guest has no absolute pointing device, or a second screen is being captured; check `screen` in `remote_vm_screenshot`. |

The VAMP output channel (**View setup log**) contains the raw check results and
the commands that were attempted.

## 9. Security boundaries

- SSH keys only; no password is stored or forwarded. `BatchMode=yes`.
- The remote server writes only inside `~/.vamp/remote`, with `0700/0600`
  permissions. It never deletes VMs, disks or registries.
- Screenshots are returned to the caller that asked for them; temporary files on
  the host are deleted after conversion to PNG.
- `remote_rpa_run` requires `confirmed=true`, and the replay engine additionally
  requires a reviewed RPA with matching checksums.
- Setup uses `sudo -n` only. If passwordless sudo is unavailable, it reports the
  command instead of asking for a password over a non-interactive channel.
