#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
python=${VAMP_DEMO_PYTHON:-python}

usage() {
    echo "Usage: $0 replay <vamp-demo-erp checkout> <new report directory> [--dryrun]" >&2
    echo "       $0 package <guest recording.py> <package ID> <new report directory>" >&2
    echo "       $0 saved-replay <request.json> <new report directory> [--dryrun|--confirm|--confirm-expect-blocked]" >&2
    echo "       $0 verified-replay <request.json> <ERP checkout> <fresh CSV path> <new report directory> --confirm" >&2
    echo "       $0 repair <request.json> <new report directory> [--validate|--test|--commit|--test-expect-rejected]" >&2
    echo "       $0 showcase <ERP checkout> <new report directory> <recording.py> <package ID> <saved request.json> <repair request.json> <fresh v1 CSV> <fresh v2 CSV>" >&2
    exit 2
}

confirm_stage() {
    local response
    printf '\n%s\nType continue when ready, or press Enter to stop: ' "$1" >&2
    read -r response && [[ $response == continue ]] || {
        echo 'Showcase stopped by the operator.' >&2
        exit 1
    }
}

if [[ ${1:-} == showcase ]]; then
    [[ $# -eq 9 && -f $2/scenario.py && -t 0 ]] || usage
    demo=$2 reports=$3 recording=$4 package_id=$5 saved_request=$6 repair_request=$7
    csv_v1=$8 csv_v2=$9
    host_url=${VAMP_DEMO_HOST_URL:-http://127.0.0.1:8080}
    [[ -n ${VAMP_RPA_REGISTRY:-} ]] || { echo 'Set VAMP_RPA_REGISTRY to the reviewed demo catalog.' >&2; exit 2; }
    "$python" - "$csv_v1" "$csv_v2" <<'PY'
from pathlib import Path
import sys

v1, v2 = map(Path, sys.argv[1:])
if v1.resolve() == v2.resolve():
    raise SystemExit('Use distinct CSV destinations for v1 and v2.')
if any(path.exists() or path.is_symlink() or not path.parent.is_dir() for path in (v1, v2)):
    raise SystemExit('Choose two unused CSV paths in existing download directories.')
PY
    mkdir -- "$reports"
    confirm_stage '1/8 Start the disposable VirtualBox guest and the standalone ERP. Confirm the fixture URL and open Orders in the guest.'
    "$python" "$demo/scenario.py" --url "$host_url" reset | tee "$reports/01-baseline.json"
    confirm_stage '2/8 Ask the AI to write a recording that ships the pending orders and exports a CSV. Review the guest coordinates and save the Python file.'

    echo '3/8 Convert the reviewed recording to Robot Framework.'
    bash "$repo/scripts/demo_e2e_showcase.sh" package "$recording" "$package_id" "$reports/03-package"
    VAMP_DEMO_EXPECTED_SOURCE_SHA256=$("$python" - "$reports/03-package/conversion-result.json" <<'PY'
import json
from pathlib import Path
import sys

report = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
conversion = json.loads(Path(report['report']).read_text(encoding='utf-8'))
print(conversion['source_sha256'])
PY
)
    export VAMP_DEMO_EXPECTED_SOURCE_SHA256
    "$python" "$demo/scenario.py" --url "$host_url" reset | tee "$reports/04-baseline.json"
    confirm_stage '4/8 Register and review this source in the demo RPA Library. Save the request with the authorized guest UUID, reload Orders with Ctrl+F5, and confirm that v1 is visible.'
    bash "$repo/scripts/demo_e2e_showcase.sh" verified-replay "$saved_request" "$demo" "$csv_v1" "$reports/04-v1" --confirm

    confirm_stage '5/8 Confirm that the original RPA should be tested on the same guest after the ERP switches to v2.'
    "$python" "$demo/scenario.py" --url "$host_url" reset | tee "$reports/05-baseline.json"
    "$python" "$demo/scenario.py" --url "$host_url" layout v2 | tee "$reports/05-layout.json"
    confirm_stage 'Refresh Orders in the guest and confirm the v2 layout is visible.'
    bash "$repo/scripts/demo_e2e_showcase.sh" saved-replay "$saved_request" "$reports/05-stale" --confirm-expect-blocked

    confirm_stage '6/8 Use CUA to inspect the changed guest UI. Review the proposed repair, then save the repair request for the same RPA.'
    "$python" - "$saved_request" "$repair_request" <<'PY'
import json
from pathlib import Path
import sys

saved, repair = [json.loads(Path(name).read_text(encoding='utf-8-sig')) for name in sys.argv[1:]]
if saved['id'].lower() != repair['id'].lower() or saved['vm_id'].lower() == repair['scratch_vm'].lower():
    raise SystemExit('Use the same RPA and a separate scratch VM for repair.')
PY
    bash "$repo/scripts/demo_e2e_showcase.sh" repair "$repair_request" "$reports/06-validation" --validate
    confirm_stage '7/8 Prepare the disconnected v2 scratch guest, OCR and modal checks, and a reset CSV baseline. Start the fixture export watcher and wait for awaiting_fresh_export. Authorize the scratch test and promotion on success.'
    bash "$repo/scripts/demo_e2e_showcase.sh" repair "$repair_request" "$reports/07-repair" --commit
    "$python" - "$reports/07-repair" "$VAMP_RPA_REGISTRY" <<'PY'
import json
from pathlib import Path
import subprocess
import sys
from uuid import UUID

reports, registry = map(Path, sys.argv[1:])
result = json.loads((reports / 'repair.json').read_text(encoding='utf-8'))
if result.get('head_verified') is not True or result.get('committed') is not True:
    raise SystemExit('The promoted revision must be verified before exporting its diff.')
catalog = registry / str(UUID(result['id']))
diff = subprocess.check_output(['git', '-C', str(catalog), 'diff', '--no-ext-diff',
                                result['head_before'], result['head_after'], '--', 'source.py'])
(reports / 'source.diff').write_bytes(diff)
PY
    VAMP_DEMO_EXPECTED_SOURCE_SHA256=$("$python" -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["source_sha256"])' "$reports/07-repair/repair.json")

    confirm_stage '8/8 Review the promoted RPA in the library. Confirm the v2 rerun and use a fresh CSV output path.'
    "$python" "$demo/scenario.py" --url "$host_url" reset | tee "$reports/08-baseline.json"
    "$python" "$demo/scenario.py" --url "$host_url" layout v2 | tee "$reports/08-layout.json"
    confirm_stage 'Refresh Orders in the target guest, dismiss any browser prompts, and restore the v2 starting screen and keyboard focus expected by the reviewed recording.'
    bash "$repo/scripts/demo_e2e_showcase.sh" verified-replay "$saved_request" "$demo" "$csv_v2" "$reports/08-v2" --confirm
    "$python" - "$csv_v1" "$csv_v2" <<'PY' | tee "$reports/08-csv-comparison.json"
import hashlib
import json
from pathlib import Path
import sys

def sha256(name):
    with Path(name).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

v1, v2 = (sha256(name) for name in sys.argv[1:])
print(json.dumps({'v1_sha256': v1, 'v2_sha256': v2, 'match': v1 == v2}, indent=2))
if v1 != v2:
    raise SystemExit('The verified v1 and v2 CSV files differ in bytes.')
PY
    exit
fi

if [[ ${1:-} == verified-replay ]]; then
    [[ $# -eq 6 && $6 == --confirm ]] || usage
    [[ -f $2 && -f $3/scenario.py ]] || { echo "Provide a request and the ERP checkout." >&2; exit 2; }
    if [[ -e $4 || -L $4 || ! -d $(dirname -- "$4") ]]; then
        echo "Choose an unused CSV path in the guest's shared download directory." >&2
        exit 2
    fi
    mkdir -- "$5"
    export VAMP_DEMO_PYTHON="$python"
    node "$repo/scripts/demo_library.mjs" saved-replay "$2" --confirm | tee "$5/saved-replay.json"
    if [[ ! -f $4 || -L $4 ]]; then
        echo "The replay did not produce the expected CSV." >&2
        exit 1
    fi
    "$python" "$3/scenario.py" verify-csv "$4" | tee "$5/csv-verification.json"
    exit
fi

if [[ ${1:-} == saved-replay || ${1:-} == repair ]]; then
    [[ $# -eq 3 || $# -eq 4 ]] || usage
    if [[ $1 == repair ]]; then
        mode=${4:---validate}
        [[ $mode == --validate || $mode == --test || $mode == --commit || $mode == --test-expect-rejected ]] || usage
    else
        mode=${4:---dryrun}
        [[ $mode == --dryrun || $mode == --confirm || $mode == --confirm-expect-blocked ]] || usage
    fi
    [[ -f $2 ]] || { echo "The demo request is missing." >&2; exit 2; }
    mkdir -- "$3"
    export VAMP_DEMO_PYTHON="$python"
    node "$repo/scripts/demo_library.mjs" "$1" "$2" "$mode" | tee "$3/$1.json"
    exit
fi

if [[ ${1:-} == package ]]; then
    [[ $# -eq 4 ]] || usage
    [[ -f $2 ]] || { echo "The guest recording file is missing." >&2; exit 2; }
    mkdir -- "$4"
    reports=$(cd -- "$4" && pwd -P)
    "$python" "$repo/recording_converter.py" "$2" --id "$3" --guest-os windows11 \
        --coordinate-space guest --width 1920 --height 1080 | tee "$reports/conversion-result.json"
    "$python" "$repo/scripts/run_rpa.py" "$3" --dryrun --output "$reports"
    exit
fi

if [[ $# -lt 3 || $# -gt 4 || $1 != replay || (${4:-} != '' && ${4:-} != --dryrun) ]]; then
    usage
fi
demo=$(cd -- "$2" && pwd -P)
suite="$demo/virtualbox_demo.robot"
if [[ ! -f "$suite" ]]; then
    echo "The ERP checkout does not contain virtualbox_demo.robot." >&2
    exit 2
fi

options=()
if [[ ${4:-} == --dryrun ]]; then
    options+=(--dryrun)
    mode=dryrun
else
    mode=replay
    for setting in VAMP_DEMO_VM VAMP_DEMO_GUEST_USER VAMP_DEMO_GUEST_PASSWORD_FILE VAMP_DEMO_V1_DOWNLOAD VAMP_DEMO_V2_DOWNLOAD; do
        if [[ -z ${!setting:-} ]]; then
            echo "Set $setting before running the VirtualBox replay." >&2
            exit 2
        fi
    done
    if [[ ! $VAMP_DEMO_VM =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
        echo "Set VAMP_DEMO_VM to the disposable VirtualBox guest UUID." >&2
        exit 2
    fi
fi

vamp_commit=$(git -C "$repo" rev-parse HEAD)
erp_commit=$(git -C "$demo" rev-parse HEAD)
vamp_changes=$(git -C "$repo" status --porcelain)
erp_changes=$(git -C "$demo" status --porcelain)
mkdir -- "$3"
reports=$(cd -- "$3" && pwd -P)

# Git Bash uses POSIX paths internally. The Windows host interpreter needs
# a Windows path inside the environment variable passed to Robot.
if command -v cygpath >/dev/null 2>&1; then
    export VAMP_DEMO_REPO=$(cygpath -m "$repo")
else
    export VAMP_DEMO_REPO="$repo"
fi

{
    printf 'mode=%s\n' "$mode"
    printf 'vamp_commit=%s\n' "$vamp_commit"
    printf 'erp_commit=%s\n' "$erp_commit"
    if [[ -n "$vamp_changes" ]]; then echo 'vamp_has_local_changes=true'; else echo 'vamp_has_local_changes=false'; fi
    if [[ -n "$erp_changes" ]]; then echo 'erp_has_local_changes=true'; else echo 'erp_has_local_changes=false'; fi
    if [[ $mode == replay ]]; then printf 'vm_uuid=%s\n' "$VAMP_DEMO_VM"; fi
} > "$reports/run-metadata.txt"

"$python" -m robot "${options[@]}" --outputdir "$reports" "$suite"
