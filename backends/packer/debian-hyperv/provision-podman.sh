#!/bin/sh
# Run inside the dedicated Hyper-V Debian VM after its mirror setup.
set -eu
. /etc/os-release
[ "$(id -u)" = 0 ] && [ "$ID" = debian ] && [ -s /etc/network/interfaces.d/vamp-static ]
deployment_keys=/home/vboxuser/.ssh/authorized_keys
test -s "$deployment_keys"

export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends podman uidmap passt slirp4netns fuse-overlayfs dbus-user-session
if ! id vamp >/dev/null 2>&1; then
    useradd --create-home --user-group --shell /bin/bash vamp
fi
getent subuid vamp >/dev/null 2>&1 || grep -q '^vamp:' /etc/subuid
getent subgid vamp >/dev/null 2>&1 || grep -q '^vamp:' /etc/subgid
install -d -m 0700 -o vamp -g vamp /home/vamp/.ssh
install -m 0600 -o vamp -g vamp "$deployment_keys" /home/vamp/.ssh/authorized_keys

uid=$(id -u vamp)
runtime=/run/user/$uid
loginctl enable-linger vamp
systemctl start "user@$uid.service"
cd /home/vamp
runuser -u vamp -- env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" \
    systemctl --user enable --now podman.socket
runuser -u vamp -- env XDG_RUNTIME_DIR="$runtime" podman info --format '{{.Host.Security.Rootless}}' | grep -qx true
test -S "$runtime/podman/podman.sock"
printf 'Rootless SSH socket: %s\n' "$runtime/podman/podman.sock"
