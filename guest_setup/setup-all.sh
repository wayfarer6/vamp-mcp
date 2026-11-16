#!/bin/sh
# Unified VAMP Guest Setup for Linux
set -eu
dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"

echo "=========================================================="
echo "  VAMP Guest Setup: RPA Recorder + Vault + Passkeys"
echo "=========================================================="

# 1. RPA Recorder Setup
echo "\n[Step 1/2] Installing RPA Recorder..."
if [ -f "$dir/recorder/setup.sh" ]; then
    sh "$dir/recorder/setup.sh"
fi

# 2. Vault Setup
echo "\n[Step 2/2] Installing KeePassXC, VeraCrypt & Removable Mount..."
if [ -f "$dir/vault/setup-guest-vault.sh" ]; then
    sh "$dir/vault/setup-guest-vault.sh"
fi

echo "\n=== All VAMP Guest Services Installed Successfully! ==="
