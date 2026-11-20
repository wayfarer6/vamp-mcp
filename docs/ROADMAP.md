# VAMP Architecture Roadmap

This document outlines the strategic engineering roadmap for VAMP (Virtual Agent Machine Platform), VAMP Vault, and the VAMP Script Hub.

---

## 1. Context & Motivation

VAMP was initially designed for **local-first** execution: the VS Code extension host, the MCP server, and the hypervisor (VirtualBox, KVM, Hyper-V) run on the user's local machine.

AI agents can run outside the local workstation, for example in a cloud service or remote development container. A secure bridge lets them use isolated desktop VMs on the user's hardware when a task requires a native desktop application.

```
Cloud / Remote AI Agent
(Jimmy, Claude, Cursor, Custom Agents)
       │
       ▼ (Encrypted MCP over SSH stdio / SSE)
User Workstation / Home Server (Local)
 ┌────────────────────────────────────────────────────────┐
 │ VAMP MCP Server (Local Process)                        │
 │  ├── VAMP Vault (KeePassXC .kdbx + VeraCrypt /m rm)   │
 │  └── Hypervisor Controller (VirtualBox / KVM / Hyper-V)│
 └─────────────────────────┬──────────────────────────────┘
                           ▼
          Isolated Guest VM (Windows 11 / Debian)
        [Accredited Certs · Exe Security Software]
```

---

## 2. Remote Hypervisor Architecture

Rather than implementing complex, proprietary remote hypervisor network protocols (e.g., SOAP for `vboxwebsrv`, WinRM/PowerShell remoting for Hyper-V) inside every individual driver, VAMP adopts a **Transport-Level Remote Bridge via MCP Stdio-over-SSH**:

### 2.1 The Transport-Level SSH Bridge (Primary Strategy)
1. **Local Hypervisor Drivers Remain Untouched:** The VAMP MCP server continues running locally on the machine hosting VirtualBox, KVM, or Hyper-V.
2. **Scoped credential delivery:** Vault stores workspace metadata and credentials in KeePassXC. After approval, it sends a requested value to the configured receiver.
3. **Native MCP Transport Compatibility:** MCP natively supports running server binaries over standard input/output (`stdio`). Wrapping the local server with SSH allows any remote agent to communicate via standard MCP JSON-RPC:

```json
{
  "mcpServers": {
    "vamp": {
      "command": "ssh",
      "args": [
        "-T",
        "user@home-workstation.local",
        "node",
        "/home/user/vamp-mcp/backends/library/server.mjs"
      ]
    }
  }
}
```

---

## 3. Milestones & Phases

### Phase 1: Native KVM over SSH (`virsh -c qemu+ssh://`) — **in progress (0.1.7)**
- **Objective:** Enable remote KVM hypervisor management across local networks and VPNs (Tailscale/WireGuard).
- **Deliverables:**
  - `backends/remote_ssh/` — a dependency-free MCP server that runs on the host owning the hypervisor and is reached over SSH stdio. Delivered tools: `remote_env_check`, `remote_env_setup`, `remote_vm_list`, `remote_vm_status`, `remote_vm_start`, `remote_vm_stop`, `remote_vm_screenshot`, `remote_vm_send_keys`, `remote_vm_mouse_click`, `remote_rpa_run`.
  - Screenshot-only display over SSH (user decision): the guest screen is returned as a PNG per request; no live stream or port forwarding is required.
  - Remote environment bootstrap: `scripts/remote_host_setup.sh` and `remote_env_setup` (Python venv, requirements, libvirt/QEMU packages with passwordless sudo, `libvirtd`, `libvirt` group, VirtualBox check).
  - VSIX integration: `vamp.remote.*` settings, the **VAMP Remote (SSH)** MCP server definition, remote manager view and commands (`setupEnvironment`, `verifyEnvironment`, `listVMs`, `captureScreenshot`, `openManager`).
  - VirtualBox remote hosts through `VBoxManage`; absolute pointer clicks are KVM-only for now.
  - Documented in [REMOTE_SETUP.md](REMOTE_SETUP.md).
  - Still open: `qemu+ssh://` URIs in `backends/kvm/client.py`, SSH port forwarding for the live VNC bridge, and keepalive/reconnection inside the bridge client.

### Phase 2: Stdio-over-SSH MCP Transport Profile — **partly delivered (0.1.7)**
- **Objective:** Provide turn-key configuration templates and helper CLI commands for remote agent connections.
- **Deliverables:**
  - Done: a working `ssh` MCP server definition (`VAMP Remote (SSH)`), an inline `mcpServers` template, SSH keepalive options (`ServerAliveInterval`), `BatchMode`/`ConnectTimeout` handling and plain-language connection errors.
  - Done: zero-trust network guidance (Tailscale, WireGuard, jump hosts) in [REMOTE_SETUP.md](REMOTE_SETUP.md).
  - Still open: a downloadable `vamp-remote-connect.json` for Cursor/Claude Desktop, reconnection inside the live viewer bridge, and Cloudflare Tunnel notes.

### Phase 3: Out-of-Band Human-in-the-Loop (HITL) Consent
- **Objective:** Maintain strict security boundaries when the user is away from their desktop monitor.
- **Deliverables:**
  - Support out-of-band approval prompts (mobile webhook, terminal prompt, or authenticated web token) when no active VS Code window is open on the host.
  - Maintain session approval caches per remote client key.

### Phase 4: Smart Screen Anchoring & Self-Healing Replay
- **Objective:** Mitigate resolution and DPI scaling fragility in PyAutoGUI absolute coordinate recordings.
- **Deliverables:**
  - Local PaddleOCR / YOLO anchor matching: locate target buttons by label text or icon template if window coordinates shift by ±20px.
  - Bounded retry loops with exponential backoff for slow-loading web/desktop forms.

### Phase 5: Automated VS Code Hub Sync
- **Objective:** Streamline script acquisition from VAMP Script Hub.
- **Deliverables:**
  - Add `VAMP: Import from Script Hub` command in VS Code.
  - One-click download and registration of community-reviewed `.zip` packages from `wayfarer6.github.io/vamp-script-hub`.

---

## 4. Security Principles for Remote Execution

1. **Host-Bound Key Custody:** Private keys, passwords, and PIM numbers are never transmitted over network pipes to the remote model.
2. **Audit Logging:** Every remote MCP tool call (`rpa_run_saved`, `vm_screenshot`, `vault_mount_volume`) is recorded in the local SQLite run history (`vm_run_history`).
3. **Fail-Closed Locking:** If an SSH connection drops, active VeraCrypt removable volumes are unmounted within `sessionCacheMinutes` expiration.

## 5. Six-stage replay demonstration

Use the same synthetic ERP order, browser, guest resolution and reset procedure for every run. Keep Windows UI capture within the retry tracked in [#19](https://github.com/wayfarer6/vamp-mcp/issues/19).

1. Show the ERP and the AI chat beside the guest view. Reset the ERP and capture the initial order state.
2. Complete the task once using screen-driven CUA, then capture the actions as PyAutoGUI source.
3. Convert the source into a Robot Framework package and show the generated `run.robot`.
4. Start the saved package through `rpa_run_saved` and retain its timing and run record.
5. Verify the expected order state with local OCR and inspect the output CSV and Robot report. Change the ERP layout and show the failed check and targeted repair.
6. Compare screen-driven CUA, a fixed recorded workflow, and VAMP replay. Report median elapsed time over equal runs, vision tokens from the provider's usage report, and success or safe stop after the UI change. Record repair runs separately from routine replays.

Report the versions, sample size, timing boundaries and raw outcomes alongside any comparison. Record unavailable usage telemetry as unavailable.
