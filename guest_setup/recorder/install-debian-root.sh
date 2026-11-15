#!/bin/sh
# For desktop users without sudo membership: su root, then run this installer.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root after su root'; exit 1; }
user_name=${1:-vboxuser}
user_home=$(getent passwd "$user_name" | cut -d: -f6)
[ -n "$user_home" ] || { echo 'Guest user not found'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
media_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
python3 "$media_dir/configure-debian-mirrors.py"
apt-get update
apt-get install -y build-essential python3-venv python3-tk python3-dev python3-dbus x11-xserver-utils xdg-user-dirs scrot gnome-session-xsession xserver-xorg
if getent group vboxsf >/dev/null; then usermod -aG vboxsf "$user_name"; fi
media_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
/usr/sbin/runuser -u "$user_name" -- env HOME="$user_home" RPA_DEPS_READY=1 sh "$media_dir/setup.sh"
echo 'Install complete. Sign out and choose GNOME on Xorg for global recording.'
