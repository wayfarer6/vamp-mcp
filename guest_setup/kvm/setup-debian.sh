#!/bin/bash
# Root post-install entrypoint. No model/AI calls; safe to rerun for the same user.
set -Eeuo pipefail
user_name=${1:-vboxuser}
[ "$(id -u)" = 0 ] || { echo 'Run as root in the guest.' >&2; exit 1; }
media=$(cd -- "$(dirname -- "$0")" && pwd)
state=/var/lib/vamp/setup
mkdir -p "$state"
exec > >(tee -a /var/log/vamp-setup.log) 2>&1
trap 'code=$?; echo VAMP-SETUP-FAILED > /dev/ttyS0; printf "{\"status\":\"failed\",\"exit_code\":%s,\"line\":%s}\n" "$code" "$LINENO" > "$state/result.json"; exit "$code"' ERR
printf '{"status":"running"}\n' > "$state/result.json"
user_home=$(getent passwd "$user_name" | cut -d: -f6)
[ -n "$user_home" ] && [ -d "$user_home" ]
export DEBIAN_FRONTEND=noninteractive
python3 "$media/recorder/configure-debian-mirrors.py"
apt-get update
apt-get install -y --no-install-recommends build-essential python3-venv python3-tk python3-dev python3-dbus x11-xserver-utils xdg-user-dirs scrot xserver-xorg lightdm lightdm-gtk-greeter openbox gmrun xterm firefox-esr fonts-dejavu dbus-x11 keepassxc libgtk-3-0t64 fuse3 sudo curl
runuser -u "$user_name" -- env HOME="$user_home" RPA_DEPS_READY=1 sh "$media/recorder/setup.sh"
runuser -u "$user_name" -- env HOME="$user_home" VAMP_VAULT_CLI_DIR="$media/cli" sh "$media/vault/setup-guest-vault.sh"
mkdir -p /etc/lightdm/lightdm.conf.d "$user_home/.config/openbox" /var/www/vamp
cat > /etc/lightdm/lightdm.conf.d/50-vamp.conf <<EOF
[Seat:*]
autologin-user=$user_name
autologin-user-timeout=0
user-session=openbox
EOF
cat > "$user_home/.config/openbox/autostart" <<'EOF'
xset s off
xset -dpms
xrandr --output Virtual-1 --mode 1920x1080
xterm -geometry 100x28+80+80 -fa Monospace -fs 16 -title VAMP-KVM-READY &
EOF
cp "$media/index.html" /var/www/vamp/index.html
cat > /etc/systemd/system/vamp-test-page.service <<'EOF'
[Unit]
Description=Local-only VAMP validation page
After=network.target
[Service]
WorkingDirectory=/var/www/vamp
ExecStart=/usr/bin/python3 -m http.server 8080 --bind 127.0.0.1
DynamicUser=yes
[Install]
WantedBy=multi-user.target
EOF
chown -R "$user_name:$user_name" "$user_home/.config"
systemctl disable gdm3 2>/dev/null || true
systemctl enable --force lightdm vamp-test-page
systemctl set-default graphical.target
cat > /etc/systemd/system/vamp-desktop-ready.service <<'EOF'
[Unit]
Description=VAMP graphical boot marker
After=display-manager.service
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo VAMP-DESKTOP-STARTED > /dev/ttyS0'
[Install]
WantedBy=graphical.target
EOF
systemctl enable vamp-desktop-ready
# Binary installation is distinct from desktop resolution / application validation.
python3 - "$state" "$user_home" <<'PY'
import json,sys,subprocess
from pathlib import Path
state=Path(sys.argv[1]);home=Path(sys.argv[2]);recorder=home/'Desktop/RPA-Recorder/.venv/bin/python'
assert recorder.is_file(), 'Recorder Python missing'
subprocess.run([str(recorder),'-c','import importlib.metadata as m; assert m.version("PyAutoGUI"); assert m.version("pynput")'],check=True)
vault=json.loads((home/'.local/share/vamp/vault-setup/result.json').read_text())
assert vault['status']=='configured', vault
result={'status':'configured','recorder_python':str(recorder),'vault':vault,'desktop_verified':False,'log':'/var/log/vamp-setup.log'}
(state/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
PY

printf 'VAMP-SETUP-CONFIGURED\n' > /dev/ttyS0
