# Changelog

## 0.1.15

- Require administrator privileges for Windows Vault MCP and its remote proxy.
- Export a decrypted copy of a single file from a verified local VeraCrypt mount, with preview and explicit approval.
- Verify local and SSH encrypted export and document elevated Windows test setup.

## 0.1.14

- Export encrypted KeePassXC databases and VeraCrypt containers to a chosen local folder from VS Code or MCP, including configured SSH vaults.

## 0.1.8

- Register only one VAMP Vault MCP definition. Choose the local target (default) or an explicitly configured remote target. Malformed remote settings never fall back to local.
- Add test-only workspace-policy groundwork; existing Vault unlock and dismount behavior is unchanged.

## Unreleased

- Add credentials by hand: **VAMP Vault: Add Credential** (`+` in the Credentials view title) asks for title, username, password, URL and notes and writes the entry to the open vault; the MCP server gains `vault_add_credential` with the same parameters. A `Group/Title` path creates the group, an existing path is never overwritten, and the password is never returned.
- Windows now installs the full signed KeePassXC application through winget (`KeePassXCTeam.KeePassXC`) instead of extracting the portable `.zip`, so `keepassxc-cli.exe` and the browser proxy come from the publisher's installer.
- Fix the VeraCrypt winget id (`IDRIX.VeraCrypt`); the previous `VeraCrypt.VeraCrypt` was rejected by winget.
- Announce the Windows User Account Control prompt before a winget install: *"Please approve the Windows User Account Control (UAC) prompt to complete the KeePassXC installation."* appears in the progress notification, a VS Code notification and the output log, and a refused prompt is reported with the command to run again.

## 0.1.5

- Restore the VAMP bat holding a monitor, with the safe inside its screen, for the Marketplace icon and matching monochrome activity-bar icon.
- Refresh the VSIX branding; vault behavior is unchanged from 0.1.4.

## 0.1.4

Remote vaults over SSH, each host with its own database.

- New **VAMP Vault (Remote) · user@host** MCP server, defined by `vamp.vault.remote`. The agent can call the local
  vault and a host's vault separately; the two never answer for each other.
- Strict isolation: every host keeps its own `~/.vamp/vault/vault.kdbx`, its own master password entry in VS Code
  secret storage (`remote-ssh://user@host:port/<path>`) and its own session cache. No code path copies, uploads or
  syncs a database between the local vault or between hosts.
- `scripts/remote_vault_setup.sh` prepares a host: private vault directory (700), Node.js 20+ check, `keepassxc-cli`
  (and optional `veracrypt`) through apt/dnf/yum/zypper/pacman/apk or a manual instruction, JSON step report,
  idempotent, never deleting a database.
- `src/remote_vault_client.mjs` runs one tool per SSH command with host/user/port/path validation and shell quoting;
  the master password is written to the remote process's standard input, never to its arguments.
- `src/remote_vault_proxy.mjs` keeps approvals and the master password on this computer: it asks the extension host
  before a read leaves, then forwards the approved call over SSH. A host is headless and cannot reach your dialogs.
- The vault server gained a headless CLI (`--call`, `--list-tools`, `--env-check`, `--version`, `--stdin-password`)
  used by the remote path; standard MCP stdio behaviour is unchanged.
- Sidebar: both views split into **📦 Local Vault** and **🌐 Remote Vault · host** once a remote vault is on, and
  remote entry rows keep the same actions (copy username, copy password, details).
- New commands: **Set Up Remote Vault (SSH)**, **Verify Remote Vault**, **Create Remote Vault**, **Unlock Remote
  Vault**, **Lock Remote Vault** (which forgets only that host's password).
- New settings: `vampVault.remote.enabled`, `.useVampRemoteSettings`, `.host`, `.port`, `.username`,
  `.privateKeyPath`, `.kdbxPath`, `.volumePath`, `.mountPoint`, `.remoteNodePath`, `.approvalMode`.
- Tests: `test/remote.mjs` (30 checks) covers injection-proof command building, settings reuse that never borrows a
  vault path, the setup script, two independent hosts over a stand-in SSH with their own `HOME`, the password never
  appearing in an argument, and the proxy's approval, per-session approval and denial paths.

## 0.1.3

- Add a searchable credential browser with explicit reveal/copy controls and encrypted export.
- Apply live agent approval policies and invalidate cached approvals on lock or policy changes.
- Use a distinct safe icon in the activity bar and Marketplace.
- Bundle English/Korean usage instructions.

## 0.1.2

- Probe the Windows VeraCrypt executable's PE version instead of launching it with Unix console flags.
- Mount through the native Windows password dialog, enumerate actual VeraCrypt drive mappings, and verify dismount without putting passwords in process arguments.
- Return an explicit interactive creation-wizard state for new Windows VeraCrypt volumes.
- Require the Visual C++ x64 runtime before Windows KeePassXC installation.
- Use the shared platform introduction and keep the VSIX checksum alongside the package instead of inside it.

## 0.1.1

Sidebar for the vault, and the .kdbx file as a first-class object.

- Activity bar container **VAMP Vault** with two views: **Vault Status** (lock state, database and volume,
  mounted volumes, resolved CLI versions, approval mode — each row clickable) and **Credentials** (the
  KeePassXC groups and entries as a tree).
- Without a CLI, without a database, or while locked, the Credentials view shows the single action that
  fixes it — *Set up KeePassXC CLI*, *Create vault* or *Unlock vault* — instead of an empty pane.
- Entry rows show the title and the username (read with `keepassxc-cli show` without `-s`, so no password
  passes through the sidebar), falling back to the group path. Names fill in for the first 200 entries in
  the background; icons are `$(key)`, `$(folder)` and `$(trash)`.
- New commands: **Reveal .kdbx File in OS File Explorer**, **Export .kdbx Copy to…**, **Search Credentials**
  (QuickPick), **Refresh**, **Unlock**, **Copy Username**, **Copy Password (Approval Required)** and
  **Show Entry Details**. Right-click menus on entries, and view title buttons for Refresh, Search,
  Lock/Unlock and the file actions.
- A password copy asks in a modal dialog with its own wording (separate from the agent's approval gate),
  then clears the clipboard after 30 seconds if it still holds the copied value. Entry details never
  include the password.
- Export writes a plain copy of the encrypted database to a path you choose — same master password, so the
  copy is worth as much as the vault; the dialog says so.
- Unlocking from the sidebar verifies the typed master password against the database before storing it, and
  a rejected stored password is forgotten rather than retried silently.
- Tests: the smoke test now covers the tree model, the manifest (every menu entry points at a declared
  command and view) and a tree built from a real database; `test/extension-host.mjs` loads the real
  `extension.js` against a stand-in `vscode` module and drives the views, copy, details, reveal, export,
  search, lock and unlock.

## 0.1.0

Initial VAMP Vault preview: credential and encrypted workspace management.

- KeePassXC MCP vault over stdio with `vault_create`, `vault_get_credential`, `vault_set_credential`,
  `vault_update_credential`, `vault_delete_credential`, `vault_list_credentials`, `vault_mount_volume`,
  `vault_unmount_volume` and `vault_status`.
- Platform-aware CLI resolver and downloader: PATH and standard install locations first, then the
  official KeePassXC AppImage/portable ZIP and VeraCrypt AppImage into extension storage, with
  publisher SHA-256 verification before the binary is used.
- VeraCrypt volume creation, mounting (PIM, key files, read-only, slot) and safe unmount through
  `veracrypt --stdin`, so passwords never appear in a process list.
- Approval bridge between the MCP server and the VS Code extension host: modal approve dialogs, the
  master password kept in VS Code secret storage, and per-entry session approval.
- Session credential cache with a configurable window, cleared on update and delete.
- Commands for CLI setup, vault creation, status and lock, plus a status bar entry and Marketplace icon.
- Documentation covering architecture, tool reference, security guide, platform matrix and the
  passkey (WebAuthn) guest-VM roadmap.
