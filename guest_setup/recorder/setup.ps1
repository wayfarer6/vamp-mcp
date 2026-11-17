$ErrorActionPreference = 'Stop'
# Run in the guest desktop user's session.
& (Join-Path $PSScriptRoot 'configure-session.ps1')
$desktop = [Environment]::GetFolderPath('Desktop')
$folder = Join-Path $desktop 'RPA-Recorder'
New-Item -ItemType Directory -Force -Path (Join-Path $folder 'recordings') | Out-Null

# Python 3.11 or newer is required; 3.11 through 3.15+ are accepted, so an
# interpreter that is already installed (including a newer one) is reused
# instead of being replaced.
function Find-RecorderPython {
    $candidates = @()
    $onPath = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    foreach ($root in @((Join-Path $env:LOCALAPPDATA 'Programs\Python'), (Join-Path $env:ProgramFiles 'Python'), 'C:\Python3')) {
        if (Test-Path -LiteralPath $root) {
            $candidates += Get-ChildItem -LiteralPath $root -Directory -Filter 'Python3*' -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending |
                ForEach-Object { Join-Path $_.FullName 'python.exe' }
        }
    }
    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        if ($candidate -like '*WindowsApps*') { continue }
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        try { & $candidate -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>$null } catch { continue }
        if ($LASTEXITCODE -eq 0) { return $candidate }
    }
    return $null
}

$pythonPath = Find-RecorderPython
if (-not $pythonPath) {
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
        & winget.exe install --exact --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
        $pythonPath = Find-RecorderPython
    }
}
if (-not $pythonPath) {
    # Clean unattended accounts may not have winget registered yet.
    $installer=Join-Path $env:TEMP 'vamp-python-3.12.10-amd64.exe'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' -OutFile $installer -TimeoutSec 180
    $signature=Get-AuthenticodeSignature -LiteralPath $installer
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Python Software Foundation'){
        throw 'Python installer signature verification failed'
    }
    $installed=Start-Process -FilePath $installer -ArgumentList @('/quiet','InstallAllUsers=0','Include_launcher=0','Include_test=0','Include_tcltk=1','PrependPath=0') -PassThru -Wait -WindowStyle Hidden
    if($installed.ExitCode -notin @(0,3010)){throw "Python installer failed: $($installed.ExitCode)"}
    $pythonPath=Find-RecorderPython
}
if (-not $pythonPath) {
    throw 'Python 3.11 or newer (3.11 through 3.15+) with tkinter is required. Install it from https://www.python.org/downloads/ and rerun setup.ps1.'
}

if (-not (Test-Path (Join-Path $folder 'PyAutoGuiRecorder.py'))) {
    # The bundle ships beside this script. When it is missing (a lone download of
    # setup.ps1), fetch the same bundle from the project repository.
    $zip = Join-Path $PSScriptRoot 'recorder.zip'
    if (-not (Test-Path -LiteralPath $zip)) {
        $uri = 'https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/guest_setup/recorder/recorder.zip'
        $zip = Join-Path $env:TEMP 'vamp-recorder.zip'
        Write-Output "recorder.zip is not beside this script; downloading it from $uri"
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $zip
        } catch {
            if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw "Recorder bundle could not be downloaded from $uri : $($_.Exception.Message)" }
            & curl.exe -fsSL $uri -o $zip
            if ($LASTEXITCODE -ne 0) { throw "Recorder bundle could not be downloaded from $uri" }
        }
        if (-not (Test-Path -LiteralPath $zip)) { throw "Recorder bundle is missing: $uri" }
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $folder -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'prepare-recording.py'), (Join-Path $PSScriptRoot 'RECORDING-GUIDE.txt'), (Join-Path $PSScriptRoot 'vamp-recorder.py'), (Join-Path $PSScriptRoot 'RECORDER-LICENSE') -Destination $folder -Force
Write-Output "Using $pythonPath"
& $pythonPath -m venv (Join-Path $folder '.venv')
if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
$venvPython = Join-Path $folder '.venv\Scripts\python.exe'
& $venvPython -m pip install -r (Join-Path $PSScriptRoot 'requirements-recorder.txt')
if ($LASTEXITCODE -ne 0) { throw 'Recorder dependency installation failed' }
@'
@echo off
cd /d "%~dp0"
".venv\Scripts\python.exe" vamp-recorder.py
pause
'@ | Set-Content -Encoding ascii -LiteralPath (Join-Path $folder 'Start-Recorder.cmd')
& $venvPython (Join-Path $PSScriptRoot 'install-display-startup.py')
if ($LASTEXITCODE -ne 0) { throw 'Display login hook registration failed' }
Write-Output "Recorder installed: $folder"
@{status='installed';recording_started=$false;session_policy='awake_unlocked'} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $folder 'installation.json')
$legacyStartup=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\RPA-Recorder-Setup.cmd'
if(Test-Path -LiteralPath $legacyStartup){Remove-Item -LiteralPath $legacyStartup -Force}
Write-Output 'Run Start-Recorder.cmd. Save recordings under recordings/. Do not record passwords.'
