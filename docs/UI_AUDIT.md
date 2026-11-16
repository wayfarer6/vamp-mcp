# VS Code UI validation — 2026-11-16

VAMP 0.1.6 / Vault 0.1.3 on Linux.

- Earlier real VS Code extension-host checks passed for activation, command registration, VM Manager and VM screen with VirtualBox and KVM.
- The later real UI audit passed RPA discovery and creation of a reviewed named skill. It timed out waiting for the saved-skill screenshot. The full theme, credential-browser and final layout capture sequence is incomplete; no full UI or accessibility certification is claimed.
- Automated manager/library tests cover inventory, lifecycle cancellation, export checksums, latest committed revisions, AI metadata and consent. Embedded manager, sidebar, library and credential scripts parse successfully.
- Credential-browser tests cover omitted secrets and lock during delayed reveal. Live KeePassXC tests cover CRUD, explicit approval, clipboard/export controls and policy changes.
- Current library layouts use scrolling and flexible sizing; sidebar selections and environment verification have explicit state indicators. Visual inspection at every window size remains incomplete.

Local evidence is retained under `artifacts/ui-validation/`; temporary VM images are excluded from the repository.
