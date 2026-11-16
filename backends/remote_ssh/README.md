# VAMP Remote Hypervisor server (SSH)

A dependency-free MCP server that runs on the machine that owns the hypervisor
and is reached over SSH stdio. It is what makes **VAMP Remote (SSH)** work; user
documentation is in [docs/REMOTE_SETUP.md](../../docs/REMOTE_SETUP.md).

```
agent / VS Code  ──ssh──►  node ~/.vamp/remote/server.mjs  ──►  virsh | VBoxManage  ──►  guest VMs
```

## Files

| File | Role |
| --- | --- |
| `server.mjs` | Entry point: MCP JSON-RPC over stdio, plus `--call` for one-shot use. |
| `tools.mjs` | Tool definitions and handlers (list/status/start/stop/screenshot/input/env/RPA). |
| `libvirt.mjs` | `virsh` output parsing, QMP click events. |
| `virtualbox.mjs` | `VBoxManage` output parsing. |
| `input.mjs` | US-layout character to QEMU qcode / PS-2 scancode maps. |
| `png.mjs` | PPM to PNG conversion (libvirt writes PPM screenshots). |
| `config.mjs` | CLI flag and environment configuration. |
| `client.mjs` | Client side used by the extension: ssh arguments, upload, tool calls, error mapping. |

## Design notes

- **Screenshots only.** The remote path returns one PNG per request instead of a
  live stream. `virsh screenshot` produces PPM, which is converted in-process, so
  the host needs no ImageMagick.
- **No new ports.** Tools travel as MCP JSON-RPC inside the SSH channel. Hypervisor
  sockets stay local to the remote host.
- **Input is explicit.** Text is typed through QEMU `input-send-event` with a US
  layout, so an unmapped character is reported instead of typed wrongly. Clicks
  use screen fractions (0-1), so they follow the last screenshot regardless of
  resolution. VirtualBox absolute clicks are reported as unsupported rather than
  pretending to work.
- **Setup never destroys.** `remote_env_setup` creates directories and a venv,
  installs packages only when `sudo -n` works, and otherwise reports the exact
  command.
- **State is not proof.** Tool output says a VM is `running`, not that its guest
  booted; a screenshot is the evidence.

## Command line

```bash
node server.mjs --help
node server.mjs --tools
node server.mjs --backend kvm --libvirt-uri qemu:///system --call remote_vm_list
node server.mjs --backend virtualbox --vboxmanage /usr/bin/VBoxManage --call remote_vm_status --args '{"vm":"lab"}'
```

Default MCP mode reads newline-delimited JSON-RPC on stdin and writes replies on
stdout. Nothing but protocol messages is written to stdout.

## Tests

```bash
cd ../../vscode-extension && npm run test:remote
```

The tests drive the real server against a fake `virsh` in a temporary `PATH`,
which covers argument building, parsing, screenshot conversion and QMP payloads
without a hypervisor. They also run the exact SSH command line through `sh` to
prove that `$HOME` is expanded by the remote shell rather than quoted away.
