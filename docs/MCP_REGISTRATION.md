# VAMP MCP registration

Use these two registrations:

| Registration | What it exposes |
| --- | --- |
| **VAMP MCP** | Virtual machine tools, reviewed RPA library tools, and the `podman_*` container tools. Local KVM and configured remote tools appear here, not as separate MCP servers. |
| **VAMP Vault** | Credential and volume tools. Vault stays separate and defaults to the local target. If you choose a configured remote Vault in its settings, that same entry points to the remote target instead. |

In VS Code, enable the definitions contributed by the current VAMP MCP Tools and VAMP Vault extensions. Do not add copies of these definitions to `.vscode/mcp.json`. **Open Containers**, **Open VM Manager**, and the Vault views remain distinct graphical surfaces.

For an external client, point **VAMP MCP** at the verified installed `vamp-mcp` binary with no arguments. Use the verified installed `vamp-mcp-vault` binary for **VAMP Vault**. These names are client settings; the Vault entry is not required if you do not use Vault.

## Using both servers in one workflow

The AI calls each server directly from the same MCP client. For a sign-in, use VAMP MCP to reach and focus the intended input field, then call `vault_deliver_credential` on VAMP Vault with the configured destination. A client that supports MCP form elicitation can show the Vault approval in chat. After approval, Vault sends the field directly to the configured receiver and returns a receipt to the AI.

For encrypted workspaces, call `vault_create_volume`, `vault_mount_volume`, `vault_attach_vm`, and `vault_detach_vm` on VAMP Vault as needed. For a configured native Linux container workspace, call Vault's `vault_attach_container` to check and approve the binding. Use VAMP MCP's `podman_workspace_detach` with the returned container ID and binding before calling Vault to unmount or delete the volume.

## Updating from the previous registrations

1. Update both extensions and reload VS Code. The previous contributed VirtualBox, KVM, Remote, RPA Library and Podman entries are no longer registered separately. The older Vault Remote registration is also removed.
2. If you entered old registrations manually, remove those entries from your user or workspace MCP settings. VAMP does not edit those settings automatically. Legacy CLI backend subcommands still work for external integrations that intentionally need them.
3. For remote VM operations, configure the intended SSH target and use the `remote_*` tools. For local Linux KVM, use `kvm_*`. If you still use the optional Python KVM/VNC runtime, keep its existing repository and profile settings and use `kvm_python_tools` and `kvm_python_call`.
4. Vault defaults to **local**. For a configured remote Vault, set `vampVault.mcpTarget` to `remote` before starting the Vault server. An invalid remote configuration does not silently select the local Vault. Verify the selected target before requesting credentials.
5. WSL remains a manual setup: opening the UI and listing tools do not enable WSL, install Podman, or start VMs. Podman tools require a separately configured named rootless SSH connection.

This is a registration change, not evidence that any VM booted, Podman connected to a real guest, or credentials were released.
