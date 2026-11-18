#!/bin/sh
set -eu
in-target apt-get -y install ca-certificates python3 openssh-server
install -m 0644 /vamp-hyperv-daemons.deb /target/tmp/vamp-hyperv-daemons.deb
test "$(chroot /target dpkg-deb -f /tmp/vamp-hyperv-daemons.deb Package)" = hyperv-daemons
test "$(chroot /target dpkg-deb -f /tmp/vamp-hyperv-daemons.deb Architecture)" = amd64
in-target dpkg -i /tmp/vamp-hyperv-daemons.deb
rm /target/tmp/vamp-hyperv-daemons.deb
sed -i '\|file:/mnt/vamp-install-dvd|d' /target/etc/apt/sources.list
umount /target/mnt/vamp-install-dvd
in-target systemctl enable ssh.service
if [ -s /vamp-static-network ]; then
    install -m 0644 /vamp-static-network /target/etc/network/interfaces.d/vamp-static
    install -m 0644 /vamp-resolv.conf /target/etc/resolv.conf
fi
if [ -s /vamp-authorized-keys ]; then
    in-target install -d -m 0700 -o vboxuser -g vboxuser /home/vboxuser/.ssh
    install -m 0600 /vamp-authorized-keys /target/home/vboxuser/.ssh/authorized_keys
    in-target chown vboxuser:vboxuser /home/vboxuser/.ssh/authorized_keys
    printf '%s\n' 'vboxuser ALL=(ALL) NOPASSWD:ALL' > /target/etc/sudoers.d/90-vamp-vboxuser
    chmod 0440 /target/etc/sudoers.d/90-vamp-vboxuser
    in-target visudo -cf /etc/sudoers
fi
