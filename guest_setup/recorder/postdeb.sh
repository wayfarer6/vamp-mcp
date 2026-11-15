#!/bin/sh
# VirtualBox Debian postinstall runs outside the target chroot.
set -eu
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
target=/
[ ! -d /target/etc ] || target=/target
mkdir -p "$target/opt/rpa-recorder-setup"
cp -R "$source_dir/." "$target/opt/rpa-recorder-setup/"
chroot "$target" /bin/sh -c '
set -eu
export DEBIAN_FRONTEND=noninteractive
python3 /opt/rpa-recorder-setup/configure-debian-mirrors.py
apt-get update
apt-get install -y build-essential python3-venv python3-tk python3-dev python3-dbus x11-xserver-utils xdg-user-dirs scrot task-gnome-desktop xorg gnome-session-xsession
if [ -f /etc/gdm3/daemon.conf ]; then
 sed -i "/^#\?WaylandEnable=/d; /\[daemon\]/a WaylandEnable=false" /etc/gdm3/daemon.conf
fi
user_home=$(getent passwd vboxuser | cut -d: -f6)
[ -n "$user_home" ]
/usr/sbin/runuser -u vboxuser -- env HOME="$user_home" RPA_DEPS_READY=1 sh /opt/rpa-recorder-setup/setup.sh
'
