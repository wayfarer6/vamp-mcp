# VAMP Windows postinstall, run at the first desktop login of the unattended account.
# It stages the setup bundle in C:\ProgramData and schedules the recorder setup for that user's session.
$ErrorActionPreference = 'Stop'
$base = if ($env:VAMP_SCRIPT_BASE_URL) { $env:VAMP_SCRIPT_BASE_URL } else { 'http://10.0.2.2:8421' }
$target = Join-Path $env:ProgramData 'RPA-Recorder-Setup'
New-Item -ItemType Directory -Force -Path $target | Out-Null
$zip = Join-Path $env:TEMP 'vamp-guest-setup.zip'
$downloaded = $false
for ($attempt = 1; $attempt -le 15; $attempt++) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/vamp-guest-setup.zip" -OutFile $zip -TimeoutSec 30
        $downloaded = $true
        break
    } catch {
        if ($attempt -eq 15) {
            throw "VAMP: cannot download $base/vamp-guest-setup.zip during postinstall. Start the host script server on port 8421. $_"
        }
        Start-Sleep -Seconds 8
    }
}
if (-not $downloaded) { throw 'VAMP: setup bundle download failed' }
Expand-Archive -LiteralPath $zip -DestinationPath $target -Force

# Install for this desktop user on the next login, never in the SYSTEM profile.
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
New-Item -ItemType Directory -Force -Path $startup | Out-Null
$setup = Join-Path $target 'recorder\setup-win.cmd'
"@call `"$setup`"" | Set-Content -Encoding ascii -LiteralPath (Join-Path $startup 'RPA-Recorder-Setup.cmd')
