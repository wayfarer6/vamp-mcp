# Run a saved CLI workflow in a VM

The RPA Library can share a Python or Playwright script, its input names, dependency lock and an optional result check as one JSON file. Each recipient reviews a version and chooses a VM on their own machine. A model can then search for the workflow, supply a different order number and read the checks. The script and its verifier run inside the guest.

## Prepare a Linux guest

1. Start a Linux VM on VirtualBox, KVM or Hyper-V. Record its VM UUID from VirtualBox Manager, `virsh domuuid NAME` or `(Get-VM -Name NAME).Id`. Hyper-V guests need Data Exchange and an active `hv_kvp_daemon` with `VirtualMachineId` in KVP pool 3. Ubuntu supplies the daemon in the Linux cloud tools for the running kernel. [Hyper-V Data Exchange](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services-data-exchange)
2. Prepare a non-root SSH worker account with rootless Podman, subordinate UID/GID ranges, cgroups v2 and a user systemd session. In that account, build the example runtime from the repository root with `podman build -t localhost/vamp-cli-workflows examples/cli-workflows`. Run `podman image inspect localhost/vamp-cli-workflows --format '{{.Id}}'` and use the full image ID with exactly one `sha256:` prefix.
3. Take the SHA-256 of the exact UTF-8 contents of each supported dependency lock. For the bundled workflows, run the following in the repository root.

```sh
python3 - <<'PY'
import hashlib, json, pathlib
for runner, lock in [('python', 'requirements.lock'), ('playwright', 'package-lock.json')]:
    package = json.loads(pathlib.Path(f'examples/cli-workflows/order-{runner}.json').read_text())
    print(runner, hashlib.sha256(package['files'][lock].encode()).hexdigest())
PY
```

4. In the guest, place `cli_worker.py` and `install_cli_worker.py` from `backends/library` side by side. Run the installer with the host's UUID, the image ID from the worker account and the lock hashes from step 3. The following example uses shell variables for those values. Set `backend` to `virtualbox`, `kvm` or `hyperv`.

```sh
sudo python3 install_cli_worker.py --backend "$backend" --vm-id "$vm_uuid" \
  --workspace orders --image "$image_id" \
  --python-lock-sha256 "$python_lock" --playwright-lock-sha256 "$playwright_lock"
```

5. Give the host a dedicated SSH key for the worker. In the guest worker's `authorized_keys`, prefix its public key with `restrict,command="/usr/bin/python3 -I /usr/local/lib/vamp/cli_worker.py"`. On the host, prepare a `known_hosts` file for that endpoint using the guest host key verified through its VM console. A forwarded port uses `[hostname]:port` as the host field.
6. In VS Code, open **VAMP: Find and Export RPA → VM workspaces**. Enter the same workspace name, backend, VM UUID and image ID, then select the host key file and client identity as prompted. For a standalone MCP, set `VAMP_RPA_REGISTRY` to the extension's `rpa-catalog` folder in the same VS Code profile and run it under the same OS user.

## Export an order

Open **Create / Import CLI → Import a shared workflow** and select [the Python example](../examples/cli-workflows/order-python.json) or [the Playwright example](../examples/cli-workflows/order-playwright.json). The Playwright workflow uses a local sample order page. Select the item in the library, inspect its entrypoint, verifier and dependency lock, and use **Review version** for your workspace.

Choose **Preview and run**. Enter `ORD-1042` for `order_id` and `order.csv` for `output_name`. Check the destination and confirm. Open **Run history** to inspect the checks or reveal the CSV. The expected row is `ORD-1042,12`. Run again with `ORD-1043` and expect `ORD-1043,24`.

A model uses the same workflow through `rpa_search` with `execution_kind: "cli_based"`, then `rpa_details`. It calls `cli_based_run_saved` with the ID, exact revision, approved workspace and declared inputs. The default is a preview. After authorization it sends `mode: "run"`, `confirmed: true` and a new UUID in `request_id`. Reuse the same request ID for a retry. Poll `cli_based_run_status` with the returned run ID.

## Author and share

Choose **Create / Import CLI → Create from source files** or **Create with AI**. Python packages use `main.py` and `requirements.lock`. Playwright packages use `main.cjs` and `package-lock.json`. Both read the declared strings as a JSON object on standard input. The working directory is the output directory. Write the requested file there using its declared leaf filename. A fresh offline container runs `verify.py` with the same inputs and the selected artifact. Print a JSON array of checks such as `[{"name":"requested_order","passed":true}]`.

A run with successful checks is marked `verified`. Without a verifier it can report `completed_unverified`. A failed check, timeout or interrupted server has its own result in run history. Each returned file is limited to 1 MiB. Prepare required software in the pinned image before execution.

**Export workflow JSON** shares the source and input contract. The recipient configures their own guest, inspects the package and approves the revision locally. Reimporting a changed entrypoint, dependency lock or verifier requires a new review.

## Validation on 2026-11-21

The locally built npm package ran the same two examples against separate Ubuntu 24.04 guests. Each cell below represents two runs, including a CSV content check on the host for both orders. Repeating an accepted request returned the original run ID.

| Guest backend | Python | Playwright |
| --- | --- | --- |
| VirtualBox | 2 verified | 2 verified |
| KVM with hardware acceleration | 2 verified | 2 verified |
| Hyper-V Generation 2 | 2 verified | 2 verified |

In a separate VS Code profile, the installed VSIX imported a package, reviewed it for Hyper-V, previewed its inputs and ran it. Its checked CSV contained `ORD-1043,24`. Three additional Hyper-V runs covered missing verification (`completed_unverified`), a wrong order (`failed`) and a time limit (`timed_out`). These runs used direct MCP calls and the VSIX. Model selection and per-provider token costs were outside this measurement.
