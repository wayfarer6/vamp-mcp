# VAMP Vault MCP

Standalone stdio MCP server for KeePassXC credential databases and optional VeraCrypt encrypted volumes. This is the same server used by the VAMP Vault extension, packaged without the VS Code UI. VM control is provided separately by `vamp-mcp` (VirtualBox and KVM).

## Install

Requires Node.js 22+. Install KeePassXC (`keepassxc-cli`) and, for encrypted volume operations, VeraCrypt separately. npm installation does not install these applications or create databases/volumes.

Download `vamp-mcp-vault-0.1.13.tgz` and `SHA256SUMS` from the [GitHub release](https://github.com/wayfarer6/vamp-mcp/releases/tag/v0.3.7). Compare the archive's SHA-256 with the corresponding release entry before installing it.

```sh
npm install -g ./vamp-mcp-vault-0.1.13.tgz
vamp-mcp-vault --version
```

Starting the installed `vamp-mcp-vault` command without flags waits for MCP requests on stdin.

## VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "vamp-vault": {
      "type": "stdio",
      "command": "vamp-mcp-vault",
      "args": [],
      "env": {
        "VAULT_KDBX": "/absolute/path/to/private.kdbx",
        "VAULT_KEEPASSXC_CLI": "/absolute/path/to/keepassxc-cli",
        "VAULT_APPROVAL_MODE": "each-read"
      }
    }
  }
}
```

Use host-specific existing paths; on Windows your client may require the installed `vamp-mcp-vault.cmd` path.

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.vamp_vault]
command = "vamp-mcp-vault"
args = []

[mcp_servers.vamp_vault.env]
VAULT_KDBX = "/absolute/path/to/private.kdbx"
VAULT_KEEPASSXC_CLI = "/absolute/path/to/keepassxc-cli"
VAULT_APPROVAL_MODE = "each-read"
```

## Unlock and approval

- Where configured, `VAULT_BRIDGE_SOCKET` and `VAULT_BRIDGE_TOKEN` connect to the running VAMP Vault VS Code extension for private unlock and approval dialogs. They are session-specific and not automatically discovered by npm.
- Without that bridge, the existing server supports `VAULT_MASTER_PASSWORD` as a headless fallback, supplied locally through your process environment. Do not commit the master password to config, paste it into a prompt, or pass it in command arguments. A headless environment variable is not equivalent to VS Code secret storage.
- Without a bridge, sensitive tools return an approval-required result unless their explicit `confirm` argument is authorized. This is caller confirmation, not an independent human dialog. The MCP client must obtain user authorization before confirming. This package preserves the server's existing policy; it does not disable approvals.

### Send a field with chat approval

`vault_deliver_credential` can ask the standalone MCP client to show an approval
form when it advertises MCP form elicitation. Configure `VAULT_KDBX`,
`VAULT_MASTER_PASSWORD`, and `VAULT_DELIVERY_TARGETS` in the server's local
environment. The last variable is a JSON object with named targets. For example,
the value below binds `demo-vm` to a single Vault field and a verified SSH guest.

```json
{
  "demo-vm": {
    "entry": "Demo/Login",
    "field": "password",
    "host": "guest.example",
    "user": "demo",
    "port": 22,
    "vmId": "970ffaa7-25cf-4b80-bcd5-e872681be153",
    "identityFile": "/home/operator/.ssh/demo",
    "knownHostsFile": "/home/operator/.ssh/demo-known-hosts"
  }
}
```

Start the guest's `vamp-vault-receive --listen password` in the active X11
session with the intended field focused. Call `vault_deliver_credential` with
`destination: "demo-vm"`, the matching `entry`, `field`, and `vm_id`. The
client shows the destination and field, and the user must check the approval box
and accept the form for each transfer. The tool returns only the delivery status
and destination. Clients without form elicitation cannot use this path.

For a container, configure its full `containerId` in place of `vmId` and omit
`vm_id` from the request. A local receiver can be configured with an absolute
`executable` and fixed `args` in place of the SSH fields. Use only receiver
programs and destinations you control. The environment configuration contains
destination metadata, so keep passwords in the Vault rather than in the JSON.
- A configured but unavailable bridge blocks policy-protected reads. Restore the bridge rather than bypassing its policy.
- Without an unlock source, operations requiring a database password report a locked/password-required result. Merely installing this package does not unlock anything.
- Approved credential reads return secrets to the calling MCP client. Request only what the task requires and keep secrets out of logs and summaries.

Use `--env-check`, `--list-tools`, and `vault_status` to inspect setup. Remote access can run the same executable over `ssh -T user@host vamp-mcp-vault`; the database and installed CLIs belong to that host.

Use `vault_create_volume` with `format: "guest-vhd"` to create a fixed VeraCrypt VHD. Supply the assigned `owner_agent_id`; Vault stores it in the encrypted KeePassXC entry's username field. Install VeraCrypt and `qemu-img` on Linux or in the configured Windows WSL distribution. Use the returned credential entry with `vault_attach_vm` on a powered-off Linux KVM, Windows VirtualBox or Hyper-V guest, then detach it with `vault_detach_vm` before deleting the volume. See the [Vault volume guide](https://github.com/wayfarer6/vamp-mcp/blob/main/vscode-vault-extension/README.md) for backend parameters and guest unlocking.

## Build from source

Prepare the existing `vscode-vault-extension` npm dependencies, then run:

```sh
npm run build --prefix npm-packages/vault
npm pack ./npm-packages/vault --pack-destination /tmp
VAMP_TEST_PACKAGE=vault VAMP_TEST_TARBALL=/tmp/vamp-mcp-vault-0.1.13.tgz npm test --prefix npm-package
```

JavaScript dependencies and their license notices are bundled. The npm package has no install scripts and does not install VS Code extensions.

[Source, setup and validation limits](https://github.com/wayfarer6/vamp-mcp)
