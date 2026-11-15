param([string]$Python = 'python', [switch]$SkipNpm)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location $root
$vbox = Join-Path $env:ProgramFiles 'Oracle/VirtualBox/VBoxManage.exe'
if (-not (Test-Path $vbox)) { throw 'Install VirtualBox for Windows from https://www.virtualbox.org/wiki/Downloads first.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22+ and reopen PowerShell first.' }
if ([int](& node -p 'process.versions.node.split(".")[0]') -lt 22) { throw 'Node.js 22+ is required.' }
if (-not $SkipNpm -and -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is missing. Complete the Node.js installation and reopen PowerShell first.' }
& $Python -m venv .venv-virtualbox
if ($LASTEXITCODE) { throw 'Python venv failed' }
$venv = Join-Path $root '.venv-virtualbox/Scripts/python.exe'
& $venv -m pip install -r backends/virtualbox/requirements.txt
if ($LASTEXITCODE) { throw 'Python dependency installation failed' }
if (-not $SkipNpm) {
    Push-Location third_party/mcp-virtualbox
    try {
        & npm.cmd ci --ignore-scripts
        if ($LASTEXITCODE) { throw 'npm ci failed' }
        & npm.cmd run build
        if ($LASTEXITCODE) { throw 'adapter build failed' }
    } finally { Pop-Location }
}
$env:VBOXMANAGE_PATH = $vbox
$env:RPA_HOST_PYTHON = $venv
$env:PYTHON_PATH = $venv
& $venv scripts/windows/host-smoke.py
if ($LASTEXITCODE) { throw 'Host smoke test failed; inspect artifacts/windows-host/result.json' }
Write-Host 'Inventory/history stdio checks passed. Use host-smoke.py --vm NAME for an existing running VM.'
Write-Host 'Mouse input additionally requires matching VirtualBox SDK and pywin32 in this venv.'
