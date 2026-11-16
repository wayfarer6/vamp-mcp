# Changelog

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

Initial VAMP Vault preview: credential and certificate isolation for AI agents.

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
