param([string]$VM = '', [string]$NodeDirectory = '', [string]$OutputDirectory = 'artifacts/windows-host', [string]$SharedOutput = '')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($NodeDirectory) { $env:PATH = "$NodeDirectory;" + $env:PATH }
$env:VBOXMANAGE_PATH = Join-Path $env:ProgramFiles 'Oracle/VirtualBox/VBoxManage.exe'
Set-Location $root
if (-not $VM) { throw 'Provide -VM for an existing diskless lab VM. Creation requires explicit nested-smoke.py --create.' }
& .venv-virtualbox/Scripts/python.exe scripts/windows/nested-smoke.py --vm $VM --output $OutputDirectory
$transportExit = $LASTEXITCODE
if ($SharedOutput) {
    New-Item -ItemType Directory -Force -Path $SharedOutput | Out-Null
    Copy-Item (Join-Path $OutputDirectory '*') $SharedOutput -Force
}
if ($transportExit) { throw 'Nested VM transport failed; inspect nested-result.json. Do not rerun creation blindly.' }
Write-Host 'NESTED TRANSPORT PASS - visual assertion still required' -ForegroundColor Green
