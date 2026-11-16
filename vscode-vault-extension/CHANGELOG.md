# Changelog

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
