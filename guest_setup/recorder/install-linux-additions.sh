#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Root required'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get install -y build-essential dkms "linux-headers-$(uname -r)"
mkdir -p /media/cdrom0
mountpoint -q /media/cdrom0 || mount -o ro /dev/sr0 /media/cdrom0
sh /media/cdrom0/VBoxLinuxAdditions.run --nox11
if getent group vboxsf >/dev/null; then usermod -aG vboxsf "${1:-vboxuser}"; fi
printf '\nVAMP_ADDITIONS_INSTALLED_REBOOT_REQUIRED\n'
# The user must reboot if modules cannot be reloaded while shares are mounted.
