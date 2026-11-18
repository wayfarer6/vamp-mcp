# Remote and optional Python tools inside one VAMP registration

`server.mjs` exports `registerRemoteTools(server, options)` and
`remoteInstructions` for `backends/unified/server.mjs`. It registers all 15
existing `remote_*` tools without renaming or changing their original handlers.
These names stay distinct from desktop `vm_*`, Library `rpa_*` and Podman tools.
Registration and tool discovery do not prepare hosts, spawn processes, connect
SSH, start Python, read VM configuration or preload models.

## Target selection must remain explicit

VS Code supplies `VAMP_REMOTE_CONFIG_JSON` using its existing remote settings:

```json
{"enabled":true,"host":"configured-host","port":22,"username":"configured-user","privateKeyPath":"/existing/key","backend":"kvm","libvirtUri":"qemu:///system","remotePythonPath":"python3","remoteNodePath":"node","remoteRepoPath":"/existing/vamp","remoteRegistryPath":"/existing/catalog","remoteVboxManagePath":"VBoxManage","connectTimeoutSeconds":10}
```

These are examples, not credentials to create. Enabled SSH routes use the
existing `RemoteSshClient.call` and fixed existing tool names. Configuration,
authentication or network failure never falls back to the local computer.
`{"enabled":false}` disables these calls. Missing host or malformed JSON fails
only when a tool is invoked, leaving the rest of VAMP usable.

When the JSON setting is absent, unified `remote_*` tools reject the call without
any local fallback. The standalone legacy remote server still manages its own
host when launched directly; that behavior is not inherited by unified routing.

## Separate local Linux KVM tools

All 15 original Node tools also have explicit local aliases, replacing only the
`remote_` prefix with `kvm_`: `kvm_packer_prepare`, `kvm_golden_images`,
`kvm_golden_image_delete`, `kvm_env_check`, `kvm_env_setup`, `kvm_vm_create`,
`kvm_vm_list`, `kvm_vm_status`, `kvm_vm_start`, `kvm_vm_stop`,
`kvm_vm_screenshot`, `kvm_vm_send_keys`, `kvm_vm_mouse_move`,
`kvm_vm_mouse_click`, `kvm_rpa_run`. They always use backend `kvm` on the local
Linux host and ignore SSH enablement/host and remote backend selection. They
reject Windows/macOS before invoking anything. `VAMP_LIBVIRT_URI` controls the
local libvirt URI; `VAMP_KVM_REPO` supplies a local checkout when needed (otherwise
the existing host-side runtime path is retained). No SSH fallback is possible.

SSH requires the previously configured/uploaded bundled remote server at
`~/.vamp/remote/server.mjs`, Node and existing host tools. The registrar does not
upload or install anything. The normal remote bundle remains supported as a
standalone server; its main guard excludes the unified server bundle. A copied
raw source file is not the uploaded bundle and is not self-contained.

## Optional original Python VM/VNC controller

Node's remote tools do not replace the Python controller's OCR, VNC, lifecycle,
RPA or exchange functions. Two explicit tools preserve access without another
MCP registration:

- `kvm_python_tools`: list the fixed 18 original tool names without starting a child.
- `kvm_python_call`: invoke one allowlisted original tool with its arguments.

Configure the existing user-managed environment separately:

```json
{"enabled":true,"python":"/existing/venv/bin/python","repo":"/existing/vamp-checkout","config":"/existing/vm-profiles.json"}
```

Supply this as `VAMP_PYTHON_CONFIG_JSON`. It refers to a **local** existing Python
repository, never the SSH target or the extension's bundled runtime. `python`, `repo` and
`config` must be absolute paths. The child receives only necessary OS/home/temp/locale
environment values, not inherited API/npm/browser credentials or Python import overrides. The wrapper starts only the fixed
`repo/vm_mcp_server.py`, sets `VM_MCP_CONFIG` when supplied, forces
`VAMP_PRELOAD_MODELS=0`, delegates to that server's original argument validation
and closes the MCP child after the result. No interpreter/dependency install,
auto-discovery or extra command-line arguments are exposed. Explicit
`vm_models` calls still have their original state-changing meaning.

Original Python tool names:
`vm_list`, `vm_rpas`, `vm_start`, `vm_inspect`, `vm_capture`, `vm_input`,
`vm_run_rpa`, `vm_read_evidence`, `vm_models`, `hyperv_open_console`,
`vm_recorder_media`, `virtualbox_create`, `vm_create`, `vm_lifecycle`,
`vm_viewer_info`, `vm_exchange_prepare`, `vm_file_put`, `vm_file_get`.

The prefix is a compatibility namespace, not a claim that all these tools use
KVM: the original Python controller also supports explicit Hyper-V/VirtualBox
operations. No generic shell-execution tool is added. Guest changes, file writes
and replay retain their original authorization requirements. Discovery lists
names; argument schemas remain those of the existing Python server. An older
checkout may reject newer allowlisted tools and reports that error without
rerouting.

## Verification scope

Registrar and routing tests use mocked subprocess/SSH/Python connections and a
real in-memory MCP SDK transport. They verify schema constraints/defaults,
namespace preservation, failure without local fallback, separate image content,
Python allowlisting/no-preload configuration and child closure. No real remote
host, VM, Python controller or container is started by these tests. Live backend
compatibility remains a separate validation step.
