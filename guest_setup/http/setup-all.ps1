# VAMP full guest setup bootstrap (recorder + vault), served by the host script server on port 8421.
#
#   powershell -ExecutionPolicy Bypass -Command "irm http://10.0.2.2:8421/setup-all.ps1 | iex"
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
& (Join-Path $work 'setup-all.ps1')
