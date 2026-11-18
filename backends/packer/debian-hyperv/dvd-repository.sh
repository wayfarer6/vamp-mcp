#!/bin/sh
set -eu
test -f /cdrom/.disk/info
test -d /cdrom/pool/main
mount_path=/target/mnt/vamp-install-dvd
mkdir -p "$mount_path"
mountpoint -q "$mount_path" || mount -o bind /cdrom "$mount_path"
printf '%s\n' 'deb [trusted=yes] file:/mnt/vamp-install-dvd trixie main' > "$1"
printf '%s\n' '#!/bin/sh' 'exit 0' > /usr/lib/apt-setup/generators/40cdrom
