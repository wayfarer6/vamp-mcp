#!/bin/sh
# VAMP Debian postinstall, run by the unattended installer as root outside the target chroot.
# It fetches the setup bundle over HTTP (host script server, port 8421) instead of a mounted media ISO.
set -eu
base=${VAMP_SCRIPT_BASE_URL:-http://10.0.2.2:8421}
work=${TMPDIR:-/tmp}/vamp-postdeb
rm -rf "$work"
mkdir -p "$work"

fetch() {
  if command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1" && return 0; fi
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1" && return 0; fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.request;urllib.request.urlretrieve(sys.argv[1],sys.argv[2])' "$1" "$2" && return 0
  fi
  return 1
}

attempt=1
while :; do
  fetch "$base/vamp-guest-setup.tar.gz" "$work/bundle.tar.gz" && break
  if [ "$attempt" -ge 15 ]; then
    echo "VAMP: cannot download $base/vamp-guest-setup.tar.gz during postinstall. Start the host script server on port 8421." >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 8
done
tar -xzf "$work/bundle.tar.gz" -C "$work"

target=/
[ ! -d /target/etc ] || target=/target
mkdir -p "$target/opt/rpa-recorder-setup"
cp -R "$work/." "$target/opt/rpa-recorder-setup/"
chroot "$target" /bin/sh -c '
set -eu
export DEBIAN_FRONTEND=noninteractive
python3 /opt/rpa-recorder-setup/recorder/configure-debian-mirrors.py
apt-get update
# VAMP guests are driven from the host over SSH. Install and enable the server
# here as well as through pkgsel/include, so a customized preseed or a Debian
# 13 image that does not ship sshd still boots with SSH reachable.
apt-get install -y openssh-server
ssh_unit=
for candidate in /lib/systemd/system/ssh.service /usr/lib/systemd/system/ssh.service /lib/systemd/system/sshd.service /usr/lib/systemd/system/sshd.service; do
 if [ -f "$candidate" ]; then ssh_unit=${candidate##*/}; break; fi
done
[ -n "$ssh_unit" ]
systemctl enable "$ssh_unit"
# The public sandbox account needs non-interactive sudo for host-side setup.
for account in vboxuser vagrant; do
 id "$account" >/dev/null 2>&1 || continue
 printf "%s ALL=(ALL) NOPASSWD:ALL\n" "$account" > "/etc/sudoers.d/90-vamp-$account"
 chmod 0440 "/etc/sudoers.d/90-vamp-$account"
done
if command -v visudo >/dev/null 2>&1; then visudo -cf /etc/sudoers >/dev/null; fi
apt-get install -y dconf-cli build-essential python3-venv python3-tk python3-dev python3-dbus x11-xserver-utils xdg-user-dirs scrot xdotool task-gnome-desktop xorg gnome-session-xsession
install -m 0755 /opt/rpa-recorder-setup/vault/vamp-vault-receive /usr/local/bin/vamp-vault-receive
python3 /opt/rpa-recorder-setup/recorder/configure-gdm.py
python3 /opt/rpa-recorder-setup/recorder/configure-debian-display.py prepare
# Debian 13 uses a static gdm.service; enabling gdm3 alone does not create
# display-manager.service when tasksel was skipped by the unattended installer.
gdm_unit=
for candidate in /usr/lib/systemd/system/gdm.service /usr/lib/systemd/system/gdm3.service /lib/systemd/system/gdm3.service; do
 if [ -f "$candidate" ]; then gdm_unit=$candidate; break; fi
done
[ -n "$gdm_unit" ]
ln -sf "$gdm_unit" /etc/systemd/system/display-manager.service
systemctl set-default graphical.target
user_home=$(getent passwd vboxuser | cut -d: -f6)
[ -n "$user_home" ]
/usr/sbin/runuser -u vboxuser -- env HOME="$user_home" RPA_DEPS_READY=1 sh /opt/rpa-recorder-setup/recorder/setup.sh
'

# Written only after the target user recorder setup exits successfully.
mkdir -p "$target/var/lib/vamp"
touch "$target/var/lib/vamp/guest-setup.complete"

# Packer waits through the first reboot, then finalizes in the auto-login desktop.
if [ -n "${VAMP_PACKER_CALLBACK:-}" ]; then
  printf '%s\n' "$VAMP_PACKER_CALLBACK" > "$target/var/lib/vamp/packer-callback"
  cat > "$target/usr/local/sbin/vamp-packer-finalize" <<'FINALIZE'
#!/bin/sh
set -eu
sleep 60
uid=$(id -u vboxuser)
user_home=$(getent passwd vboxuser | cut -d: -f6)
test -S "/run/user/$uid/bus"
/usr/sbin/runuser -u vboxuser -- env HOME="$user_home" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" DISPLAY=:0 RPA_DEPS_READY=1 sh /opt/rpa-recorder-setup/recorder/setup.sh
touch /var/lib/vamp/packer-postinstall.complete
callback=$(cat /var/lib/vamp/packer-callback)
curl --fail --retry 10 --retry-delay 5 -X POST "$callback"
systemctl disable vamp-packer-finalize.service
rm -f /var/lib/vamp/packer-callback
shutdown -h now
FINALIZE
  chmod 755 "$target/usr/local/sbin/vamp-packer-finalize"
  cat > "$target/etc/systemd/system/vamp-packer-finalize.service" <<'SERVICE'
[Unit]
Description=VAMP Packer post-login setup (60 second desktop wait)
After=display-manager.service network-online.target vamp-display-sync.service
Requires=vamp-display-sync.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/vamp-packer-finalize
TimeoutStartSec=3600
Restart=on-failure
RestartSec=15
[Install]
WantedBy=graphical.target
SERVICE
  chroot "$target" systemctl enable vamp-packer-finalize.service
fi
