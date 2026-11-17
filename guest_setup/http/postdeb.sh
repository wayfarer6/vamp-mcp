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
if [ -f /etc/gdm3/daemon.conf ]; then
 sed -i "/^#\?WaylandEnable=/d; /\[daemon\]/a WaylandEnable=false" /etc/gdm3/daemon.conf
fi
user_home=$(getent passwd vboxuser | cut -d: -f6)
[ -n "$user_home" ]
/usr/sbin/runuser -u vboxuser -- env HOME="$user_home" RPA_DEPS_READY=1 sh /opt/rpa-recorder-setup/recorder/setup.sh
'
