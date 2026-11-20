#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
python=${VAMP_DEMO_PYTHON:-python}

usage() {
    echo "Usage: $0 replay <vamp-demo-erp checkout> <new report directory> [--dryrun]" >&2
    echo "       $0 package <guest recording.py> <package ID> <new report directory>" >&2
    echo "       $0 saved-replay <request.json> <new report directory> [--dryrun|--confirm]" >&2
    echo "       $0 repair <request.json> <new report directory> [--validate|--test|--commit]" >&2
    exit 2
}

if [[ ${1:-} == saved-replay || ${1:-} == repair ]]; then
    [[ $# -eq 3 || $# -eq 4 ]] || usage
    if [[ $1 == repair ]]; then
        mode=${4:---validate}
        [[ $mode == --validate || $mode == --test || $mode == --commit ]] || usage
    else
        mode=${4:---dryrun}
        [[ $mode == --dryrun || $mode == --confirm ]] || usage
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
