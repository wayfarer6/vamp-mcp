#!/bin/sh
# Guest-only provisioning for the separate minimal image. Never run on the host.
set -eu
[ "$(id -u)" = 0 ] || exit 1
[ -f /etc/vamp-podman-build ] || { echo 'Missing dedicated guest build marker' >&2; exit 1; }
. /etc/os-release
[ "$ID" = debian ] || { echo 'Debian guest required' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends podman uidmap slirp4netns fuse-overlayfs dbus-user-session openssh-server ca-certificates
# Dedicated unprivileged user; no shared passwords, Docker group or TCP API.
id vamp >/dev/null
usermod -L vamp
if ! grep -q '^vamp:' /etc/subuid; then usermod --add-subuids 100000-165535 vamp; fi
if ! grep -q '^vamp:' /etc/subgid; then usermod --add-subgids 100000-165535 vamp; fi
install -d -m 755 /etc/ssh/sshd_config.d
printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' > /etc/ssh/sshd_config.d/00-vamp-key-only.conf
sshd -t
systemctl enable ssh
loginctl enable-linger vamp
uid=$(id -u vamp)
systemctl start "user@$uid.service"
runuser -u vamp -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user enable --now podman.socket
runuser -u vamp -- env XDG_RUNTIME_DIR="/run/user/$uid" podman info --format '{{.Host.Security.Rootless}}' | grep -qx true
[ -S "/run/user/$uid/podman/podman.sock" ]
systemctl set-default multi-user.target
# A new VM must generate its own SSH host identity before exposing SSH.
cat > /etc/systemd/system/vamp-ssh-hostkeys.service <<'UNIT'
[Unit]
Description=Generate per-VM SSH host keys
Before=ssh.service
[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A
[Install]
WantedBy=multi-user.target
UNIT
systemctl enable vamp-ssh-hostkeys.service
cat > /usr/local/sbin/vamp-finalize-image <<'FINAL'
#!/bin/sh
set -eu
install -o vamp -g vamp -m 600 /tmp/vamp-deployment.pub /home/vamp/.ssh/authorized_keys
rm -f /tmp/vamp-deployment.pub /etc/sudoers.d/vamp-build /etc/vamp-podman-build
rm -f /etc/ssh/ssh_host_*key /etc/ssh/ssh_host_*key.pub
rm -f /var/lib/dbus/machine-id
: > /etc/machine-id
rm -rf /var/lib/apt/lists/*
rm -f /root/.bash_history /home/vamp/.bash_history
rm -rf /var/log/installer
sync
/sbin/shutdown -h now
FINAL
chmod 700 /usr/local/sbin/vamp-finalize-image
