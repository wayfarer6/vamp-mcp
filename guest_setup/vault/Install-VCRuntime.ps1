# Install the x64 runtime before installing or launching KeePassXC.
param([string]$InstallerPath, [string]$ExpectedSha256)
$ErrorActionPreference = 'Stop'
function Test-VCRuntime {
    $runtime = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
    return ($runtime.Installed -eq 1 -and
        (Test-Path "$env:WINDIR\System32\msvcp140.dll") -and
        (Test-Path "$env:WINDIR\System32\vcruntime140.dll") -and
        (Test-Path "$env:WINDIR\System32\vcruntime140_1.dll"))
}
$rebootRequired = $false
if (-not (Test-VCRuntime)) {
    Write-Host 'Installing Microsoft Visual C++ x64 runtime before KeePassXC.'
    if ($InstallerPath) {
        if (-not $ExpectedSha256) { throw 'A verified installer SHA-256 is required.' }
        if ((Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'VC++ runtime installer checksum mismatch.' }
        $process = Start-Process -FilePath $InstallerPath -ArgumentList '/install /quiet /norestart' -Wait -PassThru
        if ($process.ExitCode -notin @(0,3010)) { throw "VC++ runtime installation failed: $($process.ExitCode)" }
        $rebootRequired = $process.ExitCode -eq 3010
    } else {
        & winget install --exact --id Microsoft.VCRedist.2015+.x64 --scope machine --accept-package-agreements --accept-source-agreements --silent
        if ($LASTEXITCODE -ne 0) { throw "VC++ runtime installation failed: $LASTEXITCODE" }
    }
    if (-not (Test-VCRuntime)) { throw 'VC++ x64 runtime files or installation registration are missing; KeePassXC installation stopped.' }
}
@{installed=$true;architecture='x64';reboot_required=$rebootRequired}
