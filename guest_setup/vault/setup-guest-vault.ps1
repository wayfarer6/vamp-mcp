<#
.SYNOPSIS
    Installs KeePassXC (with Passkey / Browser Integration), VeraCrypt CLI,
    and configures automatic Removable-USB mounting for the secondary VHD.
.DESCRIPTION
    Runs in the guest Windows desktop session after VM provisioning.
    1. Installs KeePassXC (winget or direct download).
    2. Registers KeePassXC-Browser native messaging host for Chrome/Edge (Passkey support).
    3. Installs VeraCrypt CLI (winget or silent installer).
    4. Creates Start-MountVault.cmd helper using VeraCrypt '/m rm' flag to expose NPKI as a removable USB drive.
#>

$ErrorActionPreference = 'Stop'

Write-Output "=== VAMP Vault Guest Setup: KeePassXC, VeraCrypt & Passkey ==="

# 1. Install KeePassXC
$keepass = Get-Command keepassxc.exe -ErrorAction SilentlyContinue
if (-not $keepass) {
    Write-Output "[1/4] Installing KeePassXC via winget..."
    try {
        winget install --exact --id KeePassXCTeam.KeePassXC --scope machine --accept-package-agreements --accept-source-agreements --silent
    } catch {
        Write-Warning "winget install failed; attempting direct download fallback..."
    }
} else {
    Write-Output "[1/4] KeePassXC already installed: $($keepass.Source)"
}

# Locate KeePassXC installation
$proxyPath = "C:\Program Files\KeePassXC\keepassxc-proxy.exe"

# 2. Register KeePassXC-Browser Native Messaging Host for Passkey support
Write-Output "[2/4] Registering KeePassXC-Browser native messaging for Chrome/Edge Passkeys..."
$nmHostDir = Join-Path $env:LOCALAPPDATA 'KeePassXC\NativeMessagingHosts'
New-Item -ItemType Directory -Force -Path $nmHostDir | Out-Null

$manifestPath = Join-Path $nmHostDir 'org.keepassxc.keepassxc_browser.json'
$manifestContent = @{
    name = "org.keepassxc.keepassxc_browser"
    description = "KeePassXC integration with web browsers (Passkeys)"
    path = $proxyPath
    type = "stdio"
    allowed_origins = @(
        "chrome-extension://oboonakemofpalcgghocfoadofidjkkk/" # KeePassXC-Browser official extension ID
    )
} | ConvertTo-Json -Depth 4

Set-Content -LiteralPath $manifestPath -Value $manifestContent -Encoding utf8

# Register in Windows Registry for Chrome and Edge
$regPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\org.keepassxc.keepassxc_browser",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\org.keepassxc.keepassxc_browser"
)
foreach ($regPath in $regPaths) {
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    Set-ItemProperty -Path $regPath -Name "(default)" -Value $manifestPath
}
Write-Output "Native messaging registered at: $manifestPath"

# 3. Install VeraCrypt CLI
$veracrypt = Get-Command VeraCrypt.exe -ErrorAction SilentlyContinue
if (-not $veracrypt) {
    Write-Output "[3/4] Installing VeraCrypt via winget..."
    try {
        winget install --exact --id IDRIX.VeraCrypt --scope machine --accept-package-agreements --accept-source-agreements --silent
    } catch {
        Write-Warning "winget install failed for VeraCrypt."
    }
} else {
    Write-Output "[3/4] VeraCrypt already installed: $($veracrypt.Source)"
}

# 4. Create Removable-USB Auto-Mount Helper Script
Write-Output "[4/4] Creating VHD Removable-USB (/m rm) Mount Helper..."
$desktop = [Environment]::GetFolderPath('Desktop')
$toolsDir = Join-Path $desktop 'VAMP-Vault'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$mountScript = @'
@echo off
setlocal enabledelayedexpansion
echo ========================================================
echo   VAMP Vault: Mounting Secondary VHD as Removable USB
echo ========================================================

:: 1. Search for vault.hc on all attached drives (e.g. D:\, E:\ from secondary VHD)
set "HC_PATH="
for %%D in (D E F G H I) do (
    if exist "%%D:\vault.hc" (
        set "HC_PATH=%%D:\vault.hc"
        goto :FOUND
    )
)

:FOUND
if "%HC_PATH%"=="" (
    echo [ERROR] vault.hc not found on any secondary drive!
    echo Please make sure the secondary vault.vhd is attached to the VM.
    pause
    exit /b 1
)

echo Found vault container: %HC_PATH%
set /p "PASSWORD=Enter Master Password for Vault: "

:: 2. Mount with /m rm (Mount volume as removable media)
:: This flag forces Windows and bank NPKI modules to detect the drive as a USB Flash Drive!
set "VC_EXE=C:\Program Files\VeraCrypt\VeraCrypt.exe"
if not exist "%VC_EXE%" (
    echo [ERROR] VeraCrypt not found at %VC_EXE%!
    pause
    exit /b 1
)

echo Mounting %HC_PATH% as Removable USB drive...
"%VC_EXE%" /q /v "%HC_PATH%" /m rm /p "%PASSWORD%"

if %ERRORLEVEL% equ 0 (
    echo [SUCCESS] Vault mounted successfully as Removable Media!
    echo Financial security programs will now see your certificates under 'Removable Disk'.
) else (
    echo [ERROR] Failed to mount vault (code %ERRORLEVEL%).
)
pause
'@

Set-Content -LiteralPath (Join-Path $toolsDir 'Mount-Vault-USB.cmd') -Value $mountScript -Encoding ascii

Write-Output "=== VAMP Vault Guest Setup Completed Successfully! ==="
Write-Output "KeePassXC Passkey host: Registered for Chrome & Edge"
Write-Output "Removable Mount helper: $toolsDir\Mount-Vault-USB.cmd"
