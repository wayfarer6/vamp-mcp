#!/bin/sh
# VAMP Vault remote host setup.
#
# Prepares one Linux/macOS host to own its own vault: a private directory for the
# database, a Node.js runtime for the vault server, and the KeePassXC command
# line tool (plus VeraCrypt when encrypted volumes are wanted). The vault server
# file itself is uploaded by the extension next to this script.
#
# Every host keeps its own database: this script never reads, copies or syncs a
# vault from anywhere else, and running it on a second host creates a second,
# unrelated vault.
#
# Safe to run repeatedly. It never deletes a database, a volume or a setting.
# Usage:
#   remote_vault_setup.sh [--vault-dir PATH] [--kdbx PATH] [--volume PATH]
#                         [--mount-point PATH] [--server PATH]
#                         [--dry-run] [--no-packages]
set -u

vault_dir="${HOME}/.vamp/vault"
kdbx=""
volume=""
mount_point=""
server=""
dry_run=0
install_packages=1
steps=""

while [ $# -gt 0 ]; do
  case "$1" in
    --vault-dir) vault_dir="${2:-}"; shift 2 ;;
    --kdbx) kdbx="${2:-}"; shift 2 ;;
    --volume) volume="${2:-}"; shift 2 ;;
    --mount-point) mount_point="${2:-}"; shift 2 ;;
    --server) server="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --no-packages) install_packages=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$kdbx" ] || kdbx="${vault_dir}/vault.kdbx"
[ -n "$volume" ] || volume="${vault_dir}/vault.hc"
[ -n "$mount_point" ] || mount_point="${vault_dir}/mnt"
[ -n "$server" ] || server="${vault_dir}/server.mjs"

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/ /g' | tr -d '\n'; }

add_step() { # id label status command [detail]
  local_entry="{\"id\":\"$(esc "$1")\",\"label\":\"$(esc "$2")\",\"status\":\"$(esc "$3")\",\"command\":\"$(esc "$4")\""
  if [ $# -ge 5 ] && [ -n "${5:-}" ]; then local_entry="${local_entry},\"detail\":\"$(esc "$5")\""; fi
  local_entry="${local_entry}}"
  if [ -n "$steps" ]; then steps="${steps},${local_entry}"; else steps="${local_entry}"; fi
}

say() { printf 'vamp: %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
sudo_ok=0
if sudo -n true >/dev/null 2>&1; then sudo_ok=1; fi

# --- private vault directory: 700 so only this account can look inside.
if [ "$dry_run" = "1" ]; then
  add_step vaultdir "Vault directory" planned "mkdir -p $vault_dir && chmod 700 $vault_dir" ""
elif mkdir -p "$vault_dir" 2>/dev/null; then
  chmod 700 "$vault_dir" 2>/dev/null
  mode="$(stat -c '%a' "$vault_dir" 2>/dev/null || stat -f '%Lp' "$vault_dir" 2>/dev/null)"
  add_step vaultdir "Vault directory" done "mkdir -p $vault_dir && chmod 700 $vault_dir" "mode ${mode:-unknown}"
else
  add_step vaultdir "Vault directory" failed "mkdir -p $vault_dir" "cannot create; check the home directory permissions"
fi

# --- Node.js: the vault server runs on it.
node_major=""
if have node; then
  node_version="$(node -p 'process.versions.node' 2>/dev/null)"
  node_major="$(printf '%s' "$node_version" | cut -d. -f1)"
  case "$node_major" in
    ''|*[!0-9]*) add_step node "Node.js runtime" needs_manual "node --version" "node answered '$node_version'" ;;
    *) if [ "$node_major" -ge 20 ]; then
         add_step node "Node.js runtime" ok "node --version" "$node_version"
       else
         add_step node "Node.js runtime" needs_manual "node --version" "found $node_version; install Node.js 20 or newer"
       fi ;;
  esac
else
  if [ "$install_packages" = "1" ] && [ "$sudo_ok" = "1" ] && [ "$dry_run" = "0" ]; then
    if have apt-get; then pkg="apt-get install -y nodejs npm"
    elif have dnf; then pkg="dnf install -y nodejs npm"
    elif have pacman; then pkg="pacman -S --noconfirm nodejs npm"
    elif have zypper; then pkg="zypper --non-interactive install nodejs npm"
    elif have apk; then pkg="apk add nodejs npm"
    else pkg=""; fi
    if [ -n "$pkg" ] && sudo -n sh -c "$pkg" >/dev/null 2>&1 && have node; then
      add_step node "Node.js runtime" done "sudo $pkg" "$(node -p 'process.versions.node' 2>/dev/null)"
    else
      add_step node "Node.js runtime" needs_manual "node --version" "install Node.js 20 or newer (nodejs.org or your package manager)"
    fi
  else
    add_step node "Node.js runtime" needs_manual "node --version" "install Node.js 20 or newer"
  fi
fi

# --- KeePassXC CLI: the only program that opens the .kdbx here.
if have keepassxc-cli; then
  add_step keepassxc "KeePassXC CLI" ok "keepassxc-cli --version" "$(keepassxc-cli --version 2>/dev/null | head -1)"
elif have flatpak && flatpak info org.keepassxc.KeePassXC >/dev/null 2>&1; then
  add_step keepassxc "KeePassXC CLI" ok "flatpak run --command=keepassxc-cli org.keepassxc.KeePassXC" "Flatpak installation"
elif [ "$install_packages" = "0" ]; then
  add_step keepassxc "KeePassXC CLI" needs_manual "keepassxc-cli --version" "install keepassxc (the package includes keepassxc-cli)"
elif [ "$dry_run" = "1" ]; then
  if have apt-get; then pkg="apt-get install -y keepassxc"
  elif have dnf; then pkg="dnf install -y keepassxc"
  elif have yum; then pkg="yum install -y keepassxc"
  elif have pacman; then pkg="pacman -S --noconfirm keepassxc"
  elif have zypper; then pkg="zypper --non-interactive install keepassxc"
  elif have apk; then pkg="apk add keepassxc"
  else pkg=""; fi
  add_step keepassxc "KeePassXC CLI" planned "sudo ${pkg:-install keepassxc}" ""
elif [ "$sudo_ok" = "1" ]; then
  if have apt-get; then pkg="apt-get install -y keepassxc"
  elif have dnf; then pkg="dnf install -y keepassxc"
  elif have yum; then pkg="yum install -y keepassxc"
  elif have pacman; then pkg="pacman -S --noconfirm keepassxc"
  elif have zypper; then pkg="zypper --non-interactive install keepassxc"
  elif have apk; then pkg="apk add keepassxc"
  else pkg=""; fi
  say "installing keepassxc"
  if [ -n "$pkg" ] && sudo -n sh -c "$pkg" >/dev/null 2>&1 && have keepassxc-cli; then
    add_step keepassxc "KeePassXC CLI" done "sudo $pkg" "$(keepassxc-cli --version 2>/dev/null | head -1)"
  else
    add_step keepassxc "KeePassXC CLI" needs_manual "keepassxc-cli --version" "install keepassxc by hand, or flatpak install flathub org.keepassxc.KeePassXC"
  fi
else
  add_step keepassxc "KeePassXC CLI" needs_manual "sudo apt install keepassxc" "passwordless sudo is unavailable"
fi

# --- VeraCrypt CLI: optional, only for the encrypted volume.
if have veracrypt; then
  add_step veracrypt "VeraCrypt CLI" ok "veracrypt --version" "$(veracrypt --version 2>/dev/null | head -1)"
elif [ "$install_packages" = "1" ] && [ "$sudo_ok" = "1" ] && [ "$dry_run" = "0" ]; then
  if have apt-get; then pkg="apt-get install -y veracrypt"
  elif have dnf; then pkg="dnf install -y veracrypt"
  elif have pacman; then pkg="pacman -S --noconfirm veracrypt"
  else pkg=""; fi
  if [ -n "$pkg" ] && sudo -n sh -c "$pkg" >/dev/null 2>&1 && have veracrypt; then
    add_step veracrypt "VeraCrypt CLI" done "sudo $pkg" "$(veracrypt --version 2>/dev/null | head -1)"
  else
    add_step veracrypt "VeraCrypt CLI" skipped "veracrypt --version" "optional: only needed for an encrypted volume; install veracrypt to use one"
  fi
else
  add_step veracrypt "VeraCrypt CLI" skipped "veracrypt --version" "optional: only needed for an encrypted volume"
fi

# --- The vault server bundle that the extension uploads beside this script.
if [ ! -f "$server" ]; then
  add_step server "Vault server file" missing "ls $server" "upload it with \"VAMP Vault: Set Up Remote Vault\""
elif [ "$dry_run" = "1" ]; then
  add_step server "Vault server file" planned "node $server --version" "$server"
elif have node; then
  out="$(node "$server" --version 2>&1 | head -1)"
  case "$out" in
    *'"status":"ok"'*) add_step server "Vault server file" ok "node $server --version" "$out" ;;
    *) add_step server "Vault server file" failed "node $server --version" "$out" ;;
  esac
else
  add_step server "Vault server file" skipped "node $server --version" "Node.js is missing"
fi

# --- Paths this host will use. A database is never created here.
if [ -f "$kdbx" ]; then
  add_step database "Vault database" ok "ls $kdbx" "exists; this host's own vault"
else
  add_step database "Vault database" pending "create with \"VAMP Vault: Create Remote Vault\"" "$kdbx"
fi
add_step volume "Volume path" skipped "ls $volume" "optional encrypted volume for certificates"
if [ "$dry_run" = "1" ]; then
  add_step mountpoint "Mount point" planned "mkdir -p $mount_point" "$mount_point"
elif mkdir -p "$mount_point" 2>/dev/null; then
  chmod 700 "$mount_point" 2>/dev/null
  add_step mountpoint "Mount point" done "mkdir -p $mount_point" "$mount_point"
else
  add_step mountpoint "Mount point" failed "mkdir -p $mount_point" "cannot create"
fi

status="ok"
case "$steps" in
  *'"status":"failed"'*) status="incomplete" ;;
  *'"status":"needs_manual"'*) status="needs_attention" ;;
esac

printf '{"status":"%s","vault_dir":"%s","kdbx":"%s","volume":"%s","mount_point":"%s","dry_run":%s,"steps":[%s],"next_step":"%s"}\n' \
  "$status" "$(esc "$vault_dir")" "$(esc "$kdbx")" "$(esc "$volume")" "$(esc "$mount_point")" \
  "$([ "$dry_run" = "1" ] && echo true || echo false)" "$steps" \
  "$([ "$status" = "ok" ] && echo 'Create this host its own vault, then unlock it; nothing is shared with any other host.' || echo 'Fix the reported steps and run setup again; no database was touched.')"
exit 0
