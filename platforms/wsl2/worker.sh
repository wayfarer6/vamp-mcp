#!/usr/bin/env bash
set -euo pipefail
dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
engine="${VAMP_WSL_CONTAINER_ENGINE:-podman}"
case "$engine" in podman|docker) ;; *) echo "Use podman or docker." >&2; exit 2;; esac
if [[ "$engine" == podman ]]; then
  [[ "$("$engine" info --format '{{.Host.Security.Rootless}}')" == true ]] || {
    echo 'Use rootless Podman.' >&2; exit 2;
  }
else
  "$engine" info --format '{{range .SecurityOptions}}{{println .}}{{end}}' |
    grep -qx 'name=rootless' || { echo 'Use rootless Docker.' >&2; exit 2; }
fi
build_network=()
if [[ "$engine" == podman ]] && command -v slirp4netns >/dev/null; then build_network=(--network=slirp4netns); fi
if [[ "${1:-serve}" == serve ]]; then
  if [[ -f "$dir/vision-mode" ]]; then
    read -r VAMP_WSL_VISION < "$dir/vision-mode"
  fi
  if [[ -f "$dir/allowed-peers" ]]; then
    python3 - "$dir/allowed-peers" "${SSH_CONNECTION:-}" <<'PYTHON'
import ipaddress
from pathlib import Path
import sys

try:
    peer = ipaddress.ip_address(sys.argv[2].split()[0])
    rules = [line.split("#", 1)[0].strip() for line in Path(sys.argv[1]).read_text().splitlines()]
    if not any(peer in ipaddress.ip_network(rule) for rule in rules if rule):
        raise ValueError()
except (IndexError, ValueError, OSError):
    sys.exit("MCP access denied by the optional SSH peer allowlist.")
PYTHON
  fi
fi
target=basic
devices=()
if [[ "${VAMP_WSL_VISION:-}" == gpu ]]; then
  target=vision
  if [[ "$engine" == podman ]]; then
    devices=(--device nvidia.com/gpu=all)
  else
    devices=(--gpus all)
  fi
fi
image="vamp-wsl-worker:$target"
case "${1:-serve}" in
  build) exec "$engine" build "${build_network[@]}" --target "$target" -t "$image" -f "$dir/Containerfile" "$dir";;
  serve) exec "$engine" run --pull=never --rm -i --read-only --network=none --cap-drop=ALL \
          --security-opt=no-new-privileges --pids-limit=128 --memory=4096m --tmpfs /tmp:rw,nosuid,nodev,size=128m \
          "${devices[@]}" "$image";;
  *) echo 'Usage: worker.sh [build|serve]' >&2; exit 2;;
esac
