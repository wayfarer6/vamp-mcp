#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 || $1 != replay || (${4:-} != '' && ${4:-} != --dryrun) ]]; then
    echo "Usage: $0 replay <vamp-demo-erp checkout> <new report directory> [--dryrun]" >&2
    exit 2
fi

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
demo=$(cd -- "$2" && pwd -P)
python=${VAMP_DEMO_PYTHON:-python}
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
