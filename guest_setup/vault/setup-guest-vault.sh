#!/bin/sh
# Runs in the Linux guest desktop user's session.
set -eu

echo "=== VAMP Vault Guest Setup (Linux): KeePassXC, VeraCrypt & Passkey ==="

# 1. Install KeePassXC & VeraCrypt
if command -v apt-get >/dev/null 2>&1; then
    echo "[1/3] Installing KeePassXC via apt..."
    sudo apt-get update
    sudo apt-get install -y keepassxc
fi

# 2. Register Native Messaging Host for KeePassXC-Browser
echo "[2/3] Registering Native Messaging Host for Passkey integration..."
nm_chrome="$HOME/.config/google-chrome/NativeMessagingHosts"
nm_firefox="$HOME/.mozilla/native-messaging-hosts"
mkdir -p "$nm_chrome" "$nm_firefox"

cat <<'EOF' > "$nm_chrome/org.keepassxc.keepassxc_browser.json"
{
    "name": "org.keepassxc.keepassxc_browser",
    "description": "KeePassXC integration with web browsers (Passkeys)",
    "path": "/usr/bin/keepassxc-proxy",
    "type": "stdio",
    "allowed_origins": [
        "chrome-extension://oboonakemofpalcgghocfoadofidjkkk/"
    ]
}
EOF

cat <<'EOF' > "$nm_firefox/org.keepassxc.keepassxc_browser.json"
{
    "name": "org.keepassxc.keepassxc_browser",
    "description": "KeePassXC integration with web browsers (Passkeys)",
    "path": "/usr/bin/keepassxc-proxy",
    "type": "stdio",
    "allowed_extensions": [
        "keepassxc-browser@keepassxc.org"
    ]
}
EOF

# 3. Mount helper for removable media
echo "[3/3] Creating Mount-Vault helper..."
desktop="${XDG_DESKTOP_DIR:-$HOME/Desktop}"
mkdir -p "$desktop/VAMP-Vault"

cat <<'EOF' > "$desktop/VAMP-Vault/mount-vault.sh"
#!/bin/sh
set -eu
echo "=== Mount VAMP Vault Container (/mount-options=removable) ==="
HC_PATH=""
for mount in /media/*/* /mnt/*; do
    if [ -f "$mount/vault.hc" ]; then
        HC_PATH="$mount/vault.hc"
        break
    fi
done

if [ -z "$HC_PATH" ]; then
    echo "vault.hc not found on attached volumes." >&2
    exit 1
fi

mkdir -p "$HOME/VAMP-Removable"
veracrypt -t --non-interactive --mount-options=removable "$HC_PATH" "$HOME/VAMP-Removable"
echo "Mounted $HC_PATH to $HOME/VAMP-Removable"
EOF
chmod +x "$desktop/VAMP-Vault/mount-vault.sh"

echo "=== Linux Guest Setup Complete ==="
