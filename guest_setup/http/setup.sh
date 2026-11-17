#!/bin/sh
# VAMP guest setup bootstrap, served by the host script server on port 8421.
#
# In the guest (VirtualBox NAT uses 10.0.2.2 for the host):
#   wget -qO- http://10.0.2.2:8421/setup.sh | sh
#   curl -fsSL http://10.0.2.2:8421/setup.sh | sh
#   wget -qO- http://10.0.2.2:8421/setup.sh | sh -s -- --all   # recorder + vault
#
# Run as the desktop user, not root: the recorder setup uses sudo only for apt.
set -eu
base=${VAMP_SCRIPT_BASE_URL:-http://10.0.2.2:8421}
mode=recorder
for arg in "$@"; do
  case "$arg" in
    --all|-a) mode=all ;;
    --base=*) base=${arg#--base=} ;;
  esac
done
work=${TMPDIR:-/tmp}/vamp-guest-setup
rm -rf "$work"
mkdir -p "$work"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1" && return 0; fi
  if command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1" && return 0; fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.request;urllib.request.urlretrieve(sys.argv[1],sys.argv[2])' "$1" "$2" && return 0
  fi
  return 1
}

attempt=1
while :; do
  fetch "$base/vamp-guest-setup.tar.gz" "$work/bundle.tar.gz" && break
  if [ "$attempt" -ge 10 ]; then
    echo "VAMP: cannot download $base/vamp-guest-setup.tar.gz. Start the host script server on port 8421 and retry." >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 6
done
tar -xzf "$work/bundle.tar.gz" -C "$work"
if [ -d "$work/cli" ]; then
  VAMP_VAULT_CLI_DIR=$work/cli
  export VAMP_VAULT_CLI_DIR
fi
if [ "$mode" = all ]; then
  exec sh "$work/setup-all.sh"
fi
exec sh "$work/recorder/setup.sh"
