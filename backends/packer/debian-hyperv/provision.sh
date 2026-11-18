#!/bin/sh
set -eu
if [ -f /var/lib/vamp/guest-setup.complete ]; then
    exit 0
fi
provision_dir=$(mktemp -d)
install -m 0600 /var/tmp/vamp-provision/vamp-guest-setup.tar.gz "$provision_dir/"
install -m 0700 /var/tmp/vamp-provision/postdeb.sh "$provision_dir/"
python3 -m http.server --bind 127.0.0.1 --directory "$provision_dir" 8421 &
server=$!
cleanup() {
    kill "$server" 2>/dev/null || true
    rm -f "$provision_dir/vamp-guest-setup.tar.gz" "$provision_dir/postdeb.sh"
    rmdir "$provision_dir"
}
trap cleanup EXIT
VAMP_SCRIPT_BASE_URL=http://127.0.0.1:8421 sh "$provision_dir/postdeb.sh"
test -f /var/lib/vamp/guest-setup.complete
