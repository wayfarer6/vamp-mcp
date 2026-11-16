# VAMP Architecture Roadmap

This document outlines the strategic engineering roadmap for VAMP (Virtual Agent Machine Platform), VAMP Vault, and the VAMP Script Hub.

---

## 1. Context & Motivation

VAMP was initially designed for **local-first** execution: the VS Code extension host, the MCP server, and the hypervisor (VirtualBox, KVM, Hyper-V) run on the user's local machine.

However, many cutting-edge AI agents (cloud-hosted autonomous agents, remote dev containers, mobile-driven assistants) execute outside the local physical workstation. Because cloud Linux containers cannot install Windows-native desktop security software (`exe` kernel modules, NPKI accredited certificates, proprietary desktop clients), they need a secure bridge to drive isolated desktop VMs running on the user's hardware.

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
2. **Zero Credential Leakage:** Master keys, certificates, and `.kdbx` databases never leave the local host filesystem. Secrets are read into guest RAM or mounted as virtual USB storage locally.
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

### Phase 1: Native KVM over SSH (`virsh -c qemu+ssh://`)
- **Objective:** Enable remote KVM hypervisor management across local networks and VPNs (Tailscale/WireGuard).
- **Deliverables:**
  - Support `qemu+ssh://` connection URIs in `backends/kvm/client.py`.
  - Automated SSH local port forwarding (`-L 5900:localhost:5900`) for the live VNC WebSocket bridge.
  - SSH key-pair authentication profiling and connectivity health checks.

### Phase 2: Stdio-over-SSH MCP Transport Profile
- **Objective:** Provide turn-key configuration templates and helper CLI commands for remote agent connections.
- **Deliverables:**
  - Create `vamp-remote-connect.json` templates for Cursor, Claude Desktop, and cloud agent clients.
  - Implement SSH keepalive and reconnection handling in the bridge client.
  - Document zero-trust network setups (Tailscale, Cloudflare Tunnel, OpenSSH).

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
