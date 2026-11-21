#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 0 || $EUID == 0 ]]; then
  echo 'Run as the non-root account used for SSH.' >&2; exit 2
fi
grep -qi 'microsoft-standard-WSL2' /proc/sys/kernel/osrelease
source /etc/os-release
if [[ "$ID" != ubuntu || ! "$VERSION_ID" =~ ^[0-9]+[.][0-9]+$ ]] || (( ${VERSION_ID%%.*} < 24 )); then
  echo 'Use Ubuntu 24.04 or later on WSL2.' >&2; exit 2;
fi
command -v podman >/dev/null || { echo 'Rootless Podman is required.' >&2; exit 2; }
src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
destination="$HOME/.local/share/vamp-wsl-worker"
vision_mode="${VAMP_WSL_VISION:-auto}"
if [[ "$vision_mode" == auto ]]; then
  vision_mode=off
  if command -v nvidia-ctk >/dev/null && nvidia-ctk cdi list 2>/dev/null | grep -Fq 'nvidia.com/gpu=all'; then
    vision_mode=gpu
  fi
fi
[[ "$vision_mode" == gpu || "$vision_mode" == off ]]
new="$(mktemp -d)"
trap 'rm -f -- "$new/"{worker.py,workflow.py,smoke.robot,vision.py,vision_process.py,Containerfile,worker.sh,scripts/download_models.py,models/manifest.json}; rmdir -- "$new/scripts" "$new/models" "$new"' EXIT
mkdir -- "$new/scripts" "$new/models"
install -m 0644 "$src/../../scripts/download_models.py" "$new/scripts/"
install -m 0644 "$src/../../models/manifest.json" "$new/models/"
install -m 0644 "$src/"{worker.py,workflow.py,smoke.robot,vision.py,vision_process.py,Containerfile} "$new/"
install -m 0755 "$src/worker.sh" "$new/worker.sh"
VAMP_WSL_VISION="$vision_mode" "$new/worker.sh" build
install -d -m 0700 "$destination"
printf '%s\n' "$vision_mode" > "$destination/vision-mode"
install -m 0755 "$new/worker.sh" "$destination/worker.sh"
printf 'MCP command on the SSH host: %s/worker.sh serve\n' "$destination"
