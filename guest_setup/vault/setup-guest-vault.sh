#!/bin/sh
# Run as the guest desktop user. Optional verified CLI media is prepared on host.
set -eu
[ "$(id -u)" != 0 ] || { echo 'Run as the desktop user, not root.' >&2; exit 1; }
state="$HOME/.local/share/vamp/vault-setup"
mkdir -p "$state"
printf '{"status":"running","passkey_login_verified":false}\n' > "$state/result.json"
trap 'printf "{\"status\":\"failed\",\"passkey_login_verified\":false}\n" > "$state/result.json"' 0
if ! command -v keepassxc-cli >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 || { echo 'Install KeePassXC first.' >&2; exit 1; }
    sudo -n apt-get update
    sudo -n apt-get install -y keepassxc
fi
proxy=$(command -v keepassxc-proxy) || { echo 'keepassxc-proxy is missing.' >&2; exit 1; }
vc=$(command -v veracrypt || true)
if [ -z "$vc" ] && [ -n "${VAMP_VAULT_CLI_DIR:-}" ]; then
    media=$VAMP_VAULT_CLI_DIR
    [ -f "$media/SHA256SUMS" ] || { echo 'Verified CLI manifest is missing.' >&2; exit 1; }
    (cd "$media" && sha256sum --strict -c SHA256SUMS > "$state/cli-checksums.log")
    [ -f "$media/veracrypt.tar.gz" ] || exit 1
    dest="$HOME/.local/share/vamp/vault-bin"
    mkdir -p "$dest" "$HOME/.local/bin"
    tar -xzf "$media/veracrypt.tar.gz" -C "$dest"
    cat > "$HOME/.local/bin/veracrypt" <<'EOF'
#!/bin/sh
app="$HOME/.local/share/vamp/vault-bin/veracrypt-appimage/squashfs-root"
export LD_LIBRARY_PATH="$app/usr/lib:$app/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$app/usr/bin/veracrypt" "$@"
EOF
    chmod +x "$HOME/.local/bin/veracrypt"
    vc="$HOME/.local/bin/veracrypt"
fi
[ -n "$vc" ] || { echo 'VeraCrypt is missing. Supply VAMP_VAULT_CLI_DIR from the verified setup media.' >&2; exit 1; }
keepassxc-cli --version > "$state/keepassxc-version.txt"
"$vc" --text --version > "$state/veracrypt-version.txt"
export VAMP_PROXY="$proxy"
python3 - <<'PY'
import json, os
from pathlib import Path
home=Path.home()
base={'name':'org.keepassxc.keepassxc_browser','description':'KeePassXC browser integration','path':os.environ['VAMP_PROXY'],'type':'stdio'}
for directory in [home/'.config/google-chrome/NativeMessagingHosts',home/'.config/chromium/NativeMessagingHosts',home/'.config/microsoft-edge/NativeMessagingHosts']:
    directory.mkdir(parents=True,exist_ok=True)
    (directory/'org.keepassxc.keepassxc_browser.json').write_text(json.dumps({**base,'allowed_origins':['chrome-extension://oboonakemofpalcgghocfoadofidjkkk/']},indent=2)+'\n')
directory=home/'.mozilla/native-messaging-hosts';directory.mkdir(parents=True,exist_ok=True)
(directory/'org.keepassxc.keepassxc_browser.json').write_text(json.dumps({**base,'allowed_extensions':['keepassxc-browser@keepassxc.org']},indent=2)+'\n')
PY
# Linux has no VeraCrypt 'removable' mount option. Prompt in the guest terminal;
# never put a volume password in argv or claim this changes the device bus type.
desktop=$(xdg-user-dir DESKTOP 2>/dev/null || printf '%s/Desktop' "$HOME")
[ "$desktop" != "$HOME" ] || desktop="$HOME/Desktop"
mkdir -p "$desktop/VAMP-Vault"
cat > "$desktop/VAMP-Vault/mount-vault.sh" <<'EOF'
#!/bin/sh
set -eu
container=${1:-}
if [ -z "$container" ]; then
    for folder in /media/*/* /mnt/*; do
        if [ -f "$folder/vault.hc" ]; then container="$folder/vault.hc"; break; fi
    done
fi
[ -f "$container" ] || { echo 'Pass the path to a vault.hc container.' >&2; exit 1; }
vc=$(command -v veracrypt || printf '%s/.local/bin/veracrypt' "$HOME")
mkdir -p "$HOME/VAMP-Vault"
exec "$vc" --text --mount "$container" "$HOME/VAMP-Vault"
EOF
chmod +x "$desktop/VAMP-Vault/mount-vault.sh"
python3 - "$state" "$vc" <<'PY'
import json,sys
from pathlib import Path
state=Path(sys.argv[1]);result={'status':'configured','keepassxc_version':(state/'keepassxc-version.txt').read_text().strip(),'veracrypt_version':(state/'veracrypt-version.txt').read_text().strip(),'veracrypt_path':sys.argv[2],'native_messaging_registered':True,'browser_extension_installed':False,'passkey_login_verified':False}
(state/'result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY
trap - 0
