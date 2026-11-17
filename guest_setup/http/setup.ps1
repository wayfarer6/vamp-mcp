# VAMP guest setup bootstrap (Windows), served by the host script server on port 8421.
#
# In the guest (VirtualBox NAT uses 10.0.2.2 for the host):
#   powershell -ExecutionPolicy Bypass -Command "irm http://10.0.2.2:8421/setup.ps1 | iex"
#   curl.exe -fsSL http://10.0.2.2:8421/setup-win.cmd -o %TEMP%\setup-win.cmd && %TEMP%\setup-win.cmd
#
# Runs in the desktop user's session; setup.ps1 installs Python for the current user.
$ErrorActionPreference = 'Stop'
$base = if ($env:VAMP_SCRIPT_BASE_URL) { $env:VAMP_SCRIPT_BASE_URL } else { 'http://10.0.2.2:8421' }
$work = Join-Path $env:TEMP 'vamp-guest-setup'
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $work | Out-Null
$zip = Join-Path $work 'vamp-guest-setup.zip'
$downloaded = $false
for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/vamp-guest-setup.zip" -OutFile $zip -TimeoutSec 30
        $downloaded = $true
        break
    } catch {
        if ($attempt -eq 10) {
            throw "VAMP: cannot download $base/vamp-guest-setup.zip. Start the host script server on port 8421 and retry. $_"
        }
        Start-Sleep -Seconds 6
    }
}
if (-not $downloaded) { throw 'VAMP: setup bundle download failed' }
Expand-Archive -LiteralPath $zip -DestinationPath $work -Force
& (Join-Path $work 'recorder/setup.ps1')
