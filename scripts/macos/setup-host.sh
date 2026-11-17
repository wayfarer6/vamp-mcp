#!/usr/bin/env bash
# VAMP host setup for macOS.
#
# Prepares this Mac to run VAMP's VirtualBox host tools: finds a Python 3.11+
# interpreter (3.15 and newer are accepted), creates .venv-virtualbox, installs
# the host requirements, and builds the bundled VirtualBox MCP adapter.
#
# Safe to run repeatedly. It never removes VMs, disks or settings, and it does
# not install system packages or change your shell profile.
# Usage:
#   scripts/macos/setup-host.sh [--python PATH] [--skip-npm]
#
# Environment:
#   VAMP_PYTHON   interpreter to use instead of auto-detection
set -euo pipefail

skip_npm=0
python_hint="${VAMP_PYTHON:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --python) [ $# -ge 2 ] || { echo 'vamp: --python needs a path' >&2; exit 2; }; python_hint="$2"; shift 2 ;;
    --skip-npm) skip_npm=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "vamp: unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf 'vamp: %s\n' "$1"; }
die() { printf 'vamp: %s\n' "$1" >&2; exit 1; }

if [ "$(uname -s)" != Darwin ]; then
  die "this script prepares a macOS host; on Linux use scripts/remote_host_setup.sh and on Windows use scripts/windows/setup-host.ps1"
fi

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
root="$(cd -- "$script_dir/../.." && pwd)"
cd "$root"
[ -f backends/virtualbox/requirements.txt ] || die "run this from the VAMP checkout; backends/virtualbox/requirements.txt is missing"

# --- Python 3.11 or newer. The interpreter compares its own version tuple, so
# --- any later release (3.15, 3.16) is accepted without a version list here.
python_ok() {
  [ -n "${1:-}" ] || return 1
  case "$1" in
    */*) [ -x "$1" ] || return 1 ;;
    *) command -v "$1" >/dev/null 2>&1 || return 1 ;;
  esac
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

python_bin=""
if [ -n "$python_hint" ]; then
  python_ok "$python_hint" || die "'$python_hint' is not Python 3.11+; install Python 3.11 or newer (3.15 and newer work too) or repair that path"
  python_bin="$python_hint"
else
  for candidate in \
    /opt/homebrew/bin/python3 \
    /usr/local/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.16/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.15/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.14/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 \
    python3.15 python3.14 python3.13 python3.12 python3.11 python3; do
    if python_ok "$candidate"; then python_bin="$candidate"; break; fi
  done
fi
[ -n "$python_bin" ] || die "Python 3.11 or newer is required (3.11 through 3.15+ are supported). Install it from https://www.python.org/downloads/ or 'brew install python@3.15', then run this script again."
say "using $("$python_bin" -c 'import sys; print("Python %d.%d.%d" % sys.version_info[:3])') ($python_bin)"

# --- Node.js 22+ runs the VirtualBox MCP server from the extension runtime.
if ! command -v node >/dev/null 2>&1; then
  die "Node.js 22+ is required. Install it from https://nodejs.org/ or 'brew install node@22', then run this script again."
fi
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$node_major" -ge 22 ] 2>/dev/null || die "Node.js 22+ is required; found $(node --version 2>/dev/null)."
say "using Node.js $(node --version)"

# --- VirtualBox is a separate download on macOS and needs its kext approval.
vbox=""
if [ -d /Applications/VirtualBox.app ] || command -v VBoxManage >/dev/null 2>&1; then
  vbox="$(command -v VBoxManage || echo /Applications/VirtualBox.app/Contents/MacOS/VBoxManage)"
  say "VirtualBox found: $("$vbox" --version 2>/dev/null || echo "$vbox")"
else
  say "VirtualBox was not found. Install it from https://www.virtualbox.org/wiki/Downloads and approve its kernel extension in System Settings > Privacy & Security. Remote and KVM over SSH desktops do not need it."
fi

# --- Isolated Python environment for the host tools.
if [ ! -x .venv-virtualbox/bin/python ]; then
  say "creating .venv-virtualbox"
  "$python_bin" -m venv .venv-virtualbox
else
  say "reusing .venv-virtualbox"
fi
say "installing backends/virtualbox/requirements.txt"
.venv-virtualbox/bin/python -m pip install --disable-pip-version-check --upgrade pip >/dev/null
.venv-virtualbox/bin/python -m pip install --disable-pip-version-check -r backends/virtualbox/requirements.txt

if [ "$skip_npm" = "0" ]; then
  if command -v npm >/dev/null 2>&1; then
    say "building the VirtualBox MCP adapter"
    ( cd third_party/mcp-virtualbox && npm ci --ignore-scripts && npm run build )
  else
    say "npm is missing; skipped the adapter build. The VS Code extension ships it already."
  fi
fi

cat <<EOF

vamp: host environment ready.
  python      $root/.venv-virtualbox/bin/python
  VBoxManage  ${vbox:-not installed}

Next, for a terminal session:
  export RPA_HOST_PYTHON="$root/.venv-virtualbox/bin/python"
  export PYTHON_PATH="$root/.venv-virtualbox/bin/python"
  export VBOXMANAGE_PATH="${vbox:-/Applications/VirtualBox.app/Contents/MacOS/VBoxManage}"
  "$root/.venv-virtualbox/bin/python" -c "import mcp, robot, asyncvnc"
  "$root/.venv-virtualbox/bin/python" scripts/windows/host-smoke.py   # needs VirtualBox

The VirtualBox mouse SDK is separate: on Apple silicon, mouse replay needs a
Python build and vboxapi matching your VirtualBox version. Set VAMP: Mouse
Python Executable when the SDK lives in another interpreter.
EOF
