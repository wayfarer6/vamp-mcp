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
apt-get install -y build-essential python3-venv python3-tk python3-dev python3-dbus x11-xserver-utils xdg-user-dirs scrot task-gnome-desktop xorg gnome-session-xsession
for gdm_config in /etc/gdm3/daemon.conf /etc/gdm/custom.conf; do
 if [ -f "$gdm_config" ]; then
  sed -i "/^#\?WaylandEnable=/d; /\[daemon\]/a WaylandEnable=false" "$gdm_config"
 fi
done
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
