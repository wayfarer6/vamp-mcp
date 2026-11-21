# Query the local audit log

Use **VAMP: Open Audit Log** in the command palette or the **Audit Log** button on the VAMP home screen. Opening it from a selected saved workflow in RPA Library preselects that script. **VAMP Vault: Open Audit Log** also works with the Vault extension installed on its own. Opening it from the Credentials view selects credential activity.

## Ask an MCP client

For “Which runs of this script did my agent start between 9 and 10?”, use the exact current catalog name or a workflow UUID from `rpa_search`. Dates below are examples in Korea Standard Time.

```json
{
  "name": "audit_search",
  "arguments": {
    "from": "2026-11-21T09:00:00+09:00",
    "to": "2026-11-21T10:00:00+09:00",
    "script_name": "Export a sample order",
    "agent_id": "orders-agent",
    "limit": 25
  }
}
```

Each filter is optional. The start is inclusive and the end exclusive. The default search window is the last 24 hours. Script names match current local catalog entries, ignoring case. Use `script_id` to find renamed or removed scripts. Name lookup on standalone MCP requires `VAMP_RPA_REGISTRY`. Use `category` to select `gui`, `cli`, `mount`, `credential` or `hypervisor`. For another page, reuse your time bounds and filters, send the returned `next_before` as `before` and keep `snapshot_seq`. Events are newest first.

Pass a returned `run_id` to `audit_run_details` to see related events within retention. CLI run IDs also work with `cli_based_run_status`. Use `audit_coverage` for the local profile, first and latest retained event, count and current MCP identity. On a configured remote VM host use `remote_audit_search` to query that host's database.

## Attribution and storage

| Source | Agent identity |
| --- | --- |
| Dedicated MCP process | Set `VAMP_AGENT_ID` in its launch environment for attribution across restarts. |
| Multiplexed client | Optional request metadata `_meta["vamp/agent_id"]` supplies a client-declared label when no operator ID is configured. |
| Other MCP calls | A process-session UUID is assigned automatically. Restarting the MCP process starts another session. |
| Manual VSIX actions | The source is VSIX and the agent is shown as unattributed. A GUI replay using the trusted Vault bridge carries the initiating run identity. |

Agent IDs describe attribution. They do not authenticate a caller or grant access. Use letters, digits, periods, underscores or hyphens for an ID (up to 64 characters, beginning with a letter or digit). All clients with access to the same OS user's audit profile can query its metadata.

The local store is `~/.vamp/audit/<profile>/events.sqlite`. The extension derives the profile from VS Code's global storage directory and passes it to its MCP server. The two VSIXs in the same VS Code profile share the store. For a standalone process, use the same registry or explicitly set `VAMP_AUDIT_PROFILE` to the profile ID shown by the panel. A standalone server with neither setting uses `default`. Local and remote hosts own separate stores. `VAMP_AUDIT_DIR` optionally overrides the audit root for a dedicated installation or test.

SQLite uses bound parameters and a write-ahead log. A workflow request or credential delivery intent is persisted before dispatch. Terminal outcomes are recorded separately. An unresolved request means the outcome was not durably confirmed. Events older than 30 days are purged on subsequent use. The implementation uses Node's built-in SQLite when available or Python 3's standard SQLite module on older runtimes.

## Reading the evidence

- CLI preview, acceptance and terminal results are distinct. A retried accepted request keeps the same run. A verified guest result may be followed up through the workflow's own artifact history.
- GUI replay and guest revision tests preserve the outcome reported by the replay engine. Remote VM tools record the host-side operation. Vault records metadata for field reads, delivery, clipboard copies, reveals and volume operations. A resolved field and a delivered field have different meanings. Neither event establishes a successful login.
- The SQLite journal stores identifiers, fixed actions, outcomes, sources and times. It omits credential values, entry paths, destination names, user inputs, filenames, screenshots and raw command output. Script display names are resolved from the local catalog when viewing history.
- Recording begins with this build. Existing CLI history and Vault/KVM JSONL files keep their original formats. The SQLite search covers events collected by the upgraded process on the selected host and profile. A quiet period alone cannot establish that a collector was online.
