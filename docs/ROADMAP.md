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

Use the same synthetic ERP order, browser, guest resolution and reset procedure for every run. Use Codex for the live AI steps.

1. Show the ERP and Codex beside the guest view. Reset the ERP and capture the initial order state.
2. Complete the task once using screen-driven CUA, then capture the actions as PyAutoGUI source.
3. Convert the source into a Robot Framework package and show the generated `run.robot`.
4. Start the saved package through `rpa_run_saved` and retain its timing and run record.
5. Verify the expected order state with local OCR and inspect the output CSV and Robot report. Change the ERP layout and show the failed check and targeted repair.
6. Compare screen-driven CUA, a fixed recorded workflow, and VAMP replay. Report median elapsed time over equal runs, vision tokens from the provider's usage report, and success or safe stop after the UI change. Record repair runs separately from routine replays.

Report the versions, sample size, timing boundaries and raw outcomes alongside any comparison. Record unavailable usage telemetry as unavailable.

### Observed ERP run

With the standalone ERP and a disposable VirtualBox browser guest ready, set the environment variables documented in the [ERP replay guide](https://github.com/wayfarer6/vamp-demo-erp#replay-against-a-virtualbox-browser-guest). From Bash (Git Bash on Windows), run:

```bash
bash scripts/demo_e2e_showcase.sh replay ../vamp-demo-erp ./erp-qa
```

Choose a new output directory. The launcher saves the Robot reports and the checkout revisions in `run-metadata.txt`. Set `VAMP_DEMO_PYTHON` to the host Python that has Robot Framework and the VirtualBox SDK. Append `--dryrun` to check the suite without guest input. This command covers the scripted ERP replay phases.

For the conversion stage, save the reviewed PyAutoGUI recording from the Windows guest on the host and run:

```bash
bash scripts/demo_e2e_showcase.sh package ./guest_recording.py erp_recorded ./erp-conversion-qa
```

The command creates `rpas/erp_recorded/run.robot`, captures the converter result, and runs a Robot dry run without guest input. Review the package before enabling replay and keep `recording.local.json` private.

For the stored replay stage, set `VAMP_RPA_REGISTRY` to the reviewed demo catalog. Put the saved RPA UUID (`id`), the test guest UUID (`vm_id`), and its declared `inputs` in a local JSON file. The launcher uses the local library MCP server and defaults to validation without input.

```bash
bash scripts/demo_e2e_showcase.sh saved-replay ./erp-request.json ./erp-saved-qa --dryrun
```

Use `--confirm` with a new report directory when the operator has authorized replay on that guest. The report records action count, status, and call duration. A `completed_unverified` result still requires the ERP CSV and screen checks.

To verify the CSV in the same run, configure the test browser to download to a shared guest folder and point the launcher to its host path:

```bash
bash scripts/demo_e2e_showcase.sh verified-replay ./erp-request.json ../vamp-demo-erp ./shared/orders.csv ./erp-verified-qa --confirm
```

Use an isolated download folder and a clean ERP fixture. The launcher requires an unused CSV filename before it sends input. It then verifies the newly downloaded file against the three expected shipped orders and records `csv-verification.json` alongside the MCP replay result.

A Windows VirtualBox guest at 1920×1080 completed a verified saved replay against the loopback ERP fixture. The MCP call took **35.97 seconds** and delivered **17 actions**. The new shared CSV matched all three expected orders. After resetting and switching to v2, the same reviewed RPA returned `starting_screen_blocked` with **zero completed actions**. These measurements cover the saved replay and its starting-screen gate.

For the repair stage, use the existing demo catalog and provide a local JSON request with `id`, `expected_commit`, and `source_file` (relative to the request file or absolute). Keep the candidate source local until it has been reviewed.

```bash
bash scripts/demo_e2e_showcase.sh repair ./erp-repair.json ./erp-repair-qa --validate
```

Static validation leaves the saved revision untouched. For an authorized scratch run, include `scratch_vm`, `outcome_text`, and the declared `test_inputs`. Use `--test` for a screen check or `--commit` after configuring all [scratch checks](WORKFLOWS.md#ai가-먼저-볼-정보). The launcher saves the verification status, call time, and Git HEAD before and after the attempt in `repair.json`. A failed verification should show an unchanged HEAD. Review a committed revision before running it again.

If v2 changes the starting-screen condition, include the new nonempty `start_text` in the repair request. Use text that occurs exactly once before the candidate sends input. The scratch check and the committed revision use the same condition. Launch the [loopback ERP fixture](https://github.com/wayfarer6/vamp-demo-erp#erp-fixture-inside-the-isolated-repair-guest) inside the disconnected scratch guest.

In an isolated Windows 11 VirtualBox guest, the stale starting condition failed and left Git HEAD unchanged. The fixture detector also blocked an initial candidate when it mistook a browser control for a modal. A revised candidate opened the actual exported CSV for its OCR check. It passed OCR, the configured YOLO check, and artifact SHA-256 verification, producing a commit that required review. After review in the QA catalog, the same source ran 30 actions through the library MCP in **54.44 seconds** and produced a fresh CSV with the expected SHA-256.

One full scripted ERP run took **239.05 seconds** in Robot Framework 7.5.1. The measurement starts at the Robot test case, after the ERP and guest browser are ready. It includes both layouts, local OCR, two CSV checks, and the stale-replay check. Both CSVs matched and the stale v1 action completed zero inputs against v2. The setup used a Windows VirtualBox browser guest at 1920×1080 and rootless Podman in a Debian VirtualBox guest. [Runner revision](https://github.com/wayfarer6/vamp-demo-erp/commit/de856ab)

A repeat with CSV baseline verification took **248.54 seconds** in the same two-guest setup. The v1 CSV verification took 90.03 seconds, the reset and stale-replay check on v2 took 24.75 seconds, and the v2 CSV verification took 121.26 seconds. The two downloads matched by SHA-256 and the stale action completed zero inputs. The test case also includes startup and preflight. [Runner revision](https://github.com/wayfarer6/vamp-demo-erp/commit/cdd925e)

A fresh run against the standalone Podman container took **270.93 seconds** including preflight. This run waited for the exact filtered order before each click. The v1 CSV verified in 100.40 seconds, the layout change and stale replay stopped with zero inputs in 31.24 seconds, and the v2 CSV verified in 123.00 seconds. Both guest downloads matched by SHA-256. These are single-run timings. [Runner revision](https://github.com/wayfarer6/vamp-demo-erp/commit/0cea8a8)

| Comparable run | Median elapsed time | Provider vision tokens | Result after layout change |
| --- | --- | --- | --- |
| Screen-driven CUA | Pending | Pending | Pending |
| Fixed recorded workflow | Pending | Pending | Pending |
| VAMP saved replay | Pending | Pending | Pending |

### Eight-stage showcase checklist

Use this sequence for the [VirtualBox ERP showcase](https://github.com/wayfarer6/vamp-mcp/issues/17). Start each layout trial from the same synthetic order state and keep each stage's files in its own report directory.

Use the guided launcher from an interactive Bash terminal. Set `VAMP_RPA_REGISTRY` to an isolated demo catalog. Set `VAMP_DEMO_HOST_URL` if the standalone ERP uses a different local URL or port.

```bash
bash scripts/demo_e2e_showcase.sh showcase ../vamp-demo-erp ./showcase-report \
  ./erp-recording.py erp_showcase ./erp-request.json ./erp-repair.json \
  ./shared/v1/orders.csv ./shared/v2/orders.csv
```

Use a new report directory and two unused CSV paths in existing shared download folders. Change the guest browser's download destination for the final run. The launcher stops at each operator checkpoint and on a failed verification. Save the live AI recording and the request files at the prompts. The repair request must name the saved RPA and a separate scratch VM.

For a terminal-only walkthrough, save the registration request as UTF-8 JSON and run `python backends/library/registry.py < registration.json` from the repository in Bash. Set `registry` to the same isolated catalog as `VAMP_RPA_REGISTRY`, `source_path` to the reviewed recording, `backend` to `virtualbox`, and `width` and `height` to `1920` and `1080`. Include `title`, `description`, `expected_result`, `start_text`, and the declared `inputs`. Set `reviewed: true` after reviewing the source. Use the response's `definition.id` in the saved replay request alongside the guest `vm_id` and runtime `inputs` object.

After scratch promotion, inspect the promoted revision with `rpa_revision read-source`. To record the operator's review in the terminal, submit a new registration request with the same `id`, the promoted `commit` as `expected_commit`, and the promoted `source_sha256` as `verified_source_hash`. Use the promoted catalog `source.py` as `source_path` and retain the definition's metadata, including the revised starting text. Set `reviewed: true` only after reviewing that exact source. The registry checks the commit and source bytes before saving the review.

The launcher checks that the v1 and stale-layout replays use the source SHA-256 from packaging. The final v2 replay must use the source verified in scratch. A mismatch stops playback before any guest input.

Save each synthetic ERP CSV to its designated shared download path. After verifying the order contents in both runs, the launcher compares the files byte for byte using SHA-256 and writes both hashes to `08-csv-comparison.json`. Different hashes fail the showcase.

| Stage | Action | Evidence to retain |
| --- | --- | --- |
| 1. Start infrastructure | Boot the disposable VirtualBox guest and launch the standalone ERP fixture. Open its Orders page in the guest. | Guest UUID, 1920×1080 desktop, ERP checkout revision, and initial order state. |
| 2. Author the recording | Ask the AI in Codex to find pending orders, mark them shipped, and export a CSV. Review the generated PyAutoGUI source and confirm it uses guest coordinates. | Prompt, reviewed source, and provider usage report when available. |
| 3. Package | Run `package` on the reviewed source and inspect the generated `run.robot`. | `conversion-result.json`, generated Robot suite, and dry-run report. |
| 4. Replay v1 | Register and review the recording in RPA Library. Run `verified-replay` against a fresh v1 fixture and an unused shared CSV path. | `saved-replay.json`, `csv-verification.json`, and the visible shipped orders. |
| 5. Switch layouts | Reset the ERP, switch to v2, then use `saved-replay <request.json> <new report directory> --confirm-expect-blocked` on the authorized guest. The replay is live, so use the disposable test guest. | `starting_screen_blocked` and zero completed actions. The launcher accepts only that pair for this stage. |
| 6. Prepare the repair | Inspect v2 in the guest through CUA, update the source and starting-screen condition, then run `repair --validate`. | AI usage when available, reviewed source diff, and static validation report. |
| 7. Verify in scratch | Run `repair --commit` against the disconnected scratch guest with OCR, the configured YOLO check, and the CSV hash check. | `repair.json` with the check results and Git revisions, and `source.diff` for the promoted change. Failed verification must preserve HEAD. |
| 8. Review and replay v2 | Review the new revision in RPA Library, reset the v2 fixture, and run `verified-replay` with a new CSV output path. | Fresh CSV verification, saved replay duration, and a split-screen view of the result. |

The launcher runs the packaging, replay, and repair commands in the table. Keep Codex authoring, guest inspection, and review confirmations visible during filming. Use separate Korean and English recordings, with the guest at 1920×1080 and video output at 2560×1440. The separate VirtualBox Notepad recording shows the guest capture and OCR validation steps in [Korean](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/04-Windows-VirtualBox-Notepad-QHD-ko.mp4) and [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/04-Windows-VirtualBox-Notepad-QHD-en.mp4).

Stage 5 was rerun on a 1920×1080 Windows VirtualBox guest with the v2 Orders page open. The launcher exited successfully after reporting `starting_screen_blocked` and zero completed actions in 11.937 seconds. The RPA catalog was in a Korean-named host folder.

For the rollback clip, reset the scratch fixture and run `repair <negative-request.json> <new report directory> --test-expect-rejected` with an authorized test candidate that leaves the expected OCR result absent. This mode never promotes a candidate. It requires a screen verification failure with zero observed matches and identical Git HEAD values before and after. Reset the scratch fixture again before testing the corrected candidate.

For the matched benchmark, record every trial before calculating medians. The [ERP benchmark guide](https://github.com/wayfarer6/vamp-demo-erp#compare-replay-methods) documents the observation fields and the `python benchmark.py observations.json` command. Keep the observations and aggregate output alongside the Robot and MCP reports.
