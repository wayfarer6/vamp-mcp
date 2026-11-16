<#
.SYNOPSIS
    Unified VAMP Guest Post-Provisioning Setup:
    1. Installs RPA Recorder (PyAutoGUI, Tkinter, virtual environment)
    2. Installs KeePassXC (with Chrome/Edge Passkey browser integration)
    3. Installs VeraCrypt CLI
    4. Configures Removable-USB (/m rm) auto-mount helper for secondary vault.vhd
#>

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot

Write-Output "=========================================================="
Write-Output "  VAMP Guest Setup: RPA Recorder + Vault + Passkeys"
Write-Output "=========================================================="

# 1. RPA Recorder Setup
Write-Output "`n[Step 1/2] Installing RPA Recorder..."
$recorderScript = Join-Path $dir 'recorder\setup.ps1'
if (Test-Path $recorderScript) {
    & $recorderScript
} else {
    Write-Warning "recorder\setup.ps1 not found, skipping."
}

# 2. Vault, Passkeys & Removable USB Setup
Write-Output "`n[Step 2/2] Installing KeePassXC, VeraCrypt & Removable Mount..."
$vaultScript = Join-Path $dir 'vault\setup-guest-vault.ps1'
if (Test-Path $vaultScript) {
    & $vaultScript
} else {
    Write-Warning "vault\setup-guest-vault.ps1 not found, skipping."
}

Write-Output "`n=== All VAMP Guest Services Installed Successfully! ==="
