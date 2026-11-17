#!/usr/bin/env bash
# VAMP remote host setup.
#
# Prepares a Linux host that owns the virtual desktops so the VAMP remote
# server can run there over SSH: Python venv, VAMP requirements, libvirt/QEMU
# (KVM) or a VirtualBox check, and the hypervisor connection.
#
# Safe to run repeatedly. It never removes VMs, images or existing settings.
# Usage:
#   scripts/remote_host_setup.sh [--backend kvm|virtualbox] [--repo PATH]
#                                [--registry PATH] [--dry-run] [--no-packages]
set -uo pipefail

backend="kvm"
repo=""
registry=""
dry_run=0
install_packages=1
steps=""

while [ $# -gt 0 ]; do
  case "$1" in
    --backend) backend="${2:-kvm}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    --registry) registry="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --no-packages) install_packages=0; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$backend" in
  kvm|virtualbox) ;;
  *) echo "Unsupported backend: $backend" >&2; exit 2 ;;
esac

workdir="${HOME}/.vamp/remote"

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g' | tr -d '\n'; }

add_step() { # id label status command [detail]
  local entry
  entry="{\"id\":\"$(esc "$1")\",\"label\":\"$(esc "$2")\",\"status\":\"$(esc "$3")\",\"command\":\"$(esc "$4")\""
  if [ $# -ge 5 ] && [ -n "${5:-}" ]; then entry="${entry},\"detail\":\"$(esc "$5")\""; fi
  entry="${entry}}"
  if [ -n "$steps" ]; then steps="${steps},${entry}"; else steps="${entry}"; fi
}

say() { printf 'vamp: %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

if [ "$dry_run" = "1" ]; then
  add_step workdir "Work directory" planned "$workdir" ""
elif mkdir -p "$workdir" 2>/dev/null && chmod 700 "$workdir" 2>/dev/null; then
  add_step workdir "Work directory" done "$workdir" ""
else
  add_step workdir "Work directory" failed "$workdir" "cannot create"
fi

# --- Node.js: the remote MCP server itself runs on it.
if have node; then
  node_version="$(node -p 'process.versions.node' 2>/dev/null)"
  add_step node "Node.js runtime" ok "node --version" "$node_version"
else
  add_step node "Node.js runtime" needs_manual "node --version" "install Node.js 20+ on this host"
fi

# --- Python for RPA replay.
python_bin="${VAMP_REMOTE_PYTHON:-python3}"
if have "$python_bin"; then
  python_version="$("$python_bin" -c 'import sys;print("%d.%d.%d"%sys.version_info[:3])' 2>/dev/null)"
  # Compare the interpreter's own version tuple so any future release (3.15, 3.16,
  # 4.x) passes without a hardcoded version list to maintain.
  if "$python_bin" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
    add_step python "Python 3.11+ (supports 3.15+)" ok "$python_bin -V" "${python_version:-unknown}"
  else
    add_step python "Python 3.11+" needs_manual "$python_bin -V" "found ${python_version:-unknown}; install 3.11 or newer"
  fi
  if [ "$dry_run" = "0" ] && [ ! -x "$workdir/venv/bin/python" ]; then
    say "creating Python virtual environment"
    if "$python_bin" -m venv "$workdir/venv" >/dev/null 2>&1; then
      add_step venv "Python virtual environment" done "$python_bin -m venv $workdir/venv" ""
    else
      add_step venv "Python virtual environment" failed "$python_bin -m venv $workdir/venv" "python3-venv may be missing"
    fi
  else
    add_step venv "Python virtual environment" skipped "$workdir/venv" "already present or dry run"
  fi
  if [ -n "$repo" ] && [ -f "$repo/requirements-mcp.txt" ] && [ -x "$workdir/venv/bin/python" ] && [ "$dry_run" = "0" ]; then
    say "installing VAMP MCP requirements (this can take a while)"
    if "$workdir/venv/bin/python" -m pip install --disable-pip-version-check --no-input -r "$repo/requirements-mcp.txt" >/dev/null 2>&1; then
      add_step requirements "VAMP MCP requirements" done "pip install -r $repo/requirements-mcp.txt" ""
    else
      add_step requirements "VAMP MCP requirements" failed "pip install -r $repo/requirements-mcp.txt" "see pip output above"
    fi
  else
    add_step requirements "VAMP MCP requirements" skipped "requirements-mcp.txt" "no repository or venv; RPA replay disabled"
  fi
else
  add_step python "Python 3.11+" needs_manual "$python_bin -V" "install Python 3.11 or newer"
fi

# --- Hypervisor.
sudo_ok=0
if sudo -n true >/dev/null 2>&1; then sudo_ok=1; fi

if [ "$backend" = "kvm" ]; then
  if have virsh; then
    add_step virsh "libvirt client" ok "virsh --version" "$(virsh --version 2>/dev/null)"
  elif [ "$install_packages" = "0" ]; then
    add_step virsh "libvirt client" needs_manual "install libvirt" ""
  else
    if have apt-get; then pkg_cmd="apt-get install -y qemu-kvm libvirt-daemon-system libvirt-clients virtinst qemu-utils"
    elif have dnf; then pkg_cmd="dnf install -y qemu-kvm libvirt-daemon-kvm virt-install qemu-img"
    elif have yum; then pkg_cmd="yum install -y qemu-kvm libvirt libvirt-client virt-install qemu-img"
    elif have zypper; then pkg_cmd="zypper --non-interactive install qemu-kvm libvirt virt-install"
    elif have pacman; then pkg_cmd="pacman -S --noconfirm libvirt qemu-full"
    else pkg_cmd="apt-get install -y qemu-kvm libvirt-daemon-system libvirt-clients virtinst"; fi
    if [ "$dry_run" = "1" ]; then
      add_step libvirt-install "Install libvirt and QEMU" planned "sudo $pkg_cmd" ""
    elif [ "$sudo_ok" = "1" ]; then
      say "installing libvirt and QEMU"
      if sudo -n sh -c "$pkg_cmd" >/dev/null 2>&1; then
        add_step libvirt-install "Install libvirt and QEMU" done "sudo $pkg_cmd" ""
        sudo -n systemctl enable --now libvirtd >/dev/null 2>&1 && add_step libvirtd "Enable and start libvirtd" done "systemctl enable --now libvirtd" ""
        sudo -n usermod -aG libvirt "$(id -un)" >/dev/null 2>&1 && add_step libvirt-group "Allow this user to manage system VMs" done "usermod -aG libvirt $(id -un)" "log out and back in for the group change"
      else
        add_step libvirt-install "Install libvirt and QEMU" failed "sudo $pkg_cmd" "package install failed"
      fi
    else
      add_step libvirt-install "Install libvirt and QEMU" needs_manual "sudo $pkg_cmd" "passwordless sudo is unavailable"
    fi
  fi
  libvirt_uri="${VAMP_LIBVIRT_URI:-qemu:///system}"
  if have virsh; then
    if domains="$(virsh -c "$libvirt_uri" list --all --uuid 2>/dev/null)"; then
      count="$(printf '%s' "$domains" | grep -c . )"
      add_step libvirt "libvirt connection" ok "virsh -c $libvirt_uri list --all" "$count domain line(s)"
    else
      add_step libvirt "libvirt connection" failed "virsh -c $libvirt_uri list --all" "start libvirtd and check permissions"
    fi
  fi
else
  if have VBoxManage; then
    add_step vboxmanage "VBoxManage" ok "VBoxManage --version" "$(VBoxManage --version 2>/dev/null | head -1)"
  else
    add_step vboxmanage "VBoxManage" needs_manual "VBoxManage --version" "install VirtualBox from virtualbox.org"
  fi
fi

script_path="$workdir"
if [ -n "$repo" ] && [ -f "$repo/backends/library/replay.py" ]; then
  add_step repo "VAMP repository for RPA replay" ok "$repo" ""
else
  add_step repo "VAMP repository for RPA replay" skipped "${repo:-not configured}" "VM lifecycle and screenshots still work"
fi

if [ -n "$registry" ]; then
  mkdir -p "$registry" 2>/dev/null
  add_step registry "Saved RPA registry" done "$registry" ""
fi

status="ok"
case "$steps" in *'"status":"failed"'*) status="incomplete" ;; *'"status":"needs_manual"'*) status="needs_attention" ;; esac

printf '{"status":"%s","backend":"%s","dry_run":%s,"steps":[%s],"next_step":"%s"}\n' \
  "$status" "$backend" "$([ "$dry_run" = "1" ] && echo true || echo false)" "$steps" \
  "$([ "$status" = "ok" ] && echo 'Verify with remote_env_check, then list desktops.' || echo 'Fix the reported steps and run setup again; nothing was removed.')"
exit 0
