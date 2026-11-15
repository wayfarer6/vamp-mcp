$ErrorActionPreference = 'Stop'
# Run in the guest desktop user's session. No administrator requirement.
$desktop = [Environment]::GetFolderPath('Desktop')
$folder = Join-Path $desktop 'RPA-Recorder'
New-Item -ItemType Directory -Force -Path (Join-Path $folder 'recordings') | Out-Null
$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python -or $python.Source -like '*WindowsApps*') {
    winget install --exact --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 with tkinter, then rerun setup.ps1.' }
    $pythonPath = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
} else { $pythonPath = $python.Source }
if (-not (Test-Path (Join-Path $folder 'PyAutoGuiRecorder.py'))) {
    Expand-Archive -LiteralPath (Join-Path $PSScriptRoot 'recorder.zip') -DestinationPath $folder
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'prepare-recording.py'), (Join-Path $PSScriptRoot 'RECORDING-GUIDE.txt'), (Join-Path $PSScriptRoot 'vamp-recorder.py'), (Join-Path $PSScriptRoot 'RECORDER-LICENSE') -Destination $folder -Force
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
Write-Output 'Run Start-Recorder.cmd. Save recordings under recordings/. Do not record passwords.'
