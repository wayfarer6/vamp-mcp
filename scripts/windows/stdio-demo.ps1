param([string]$NodeDirectory = '', [string]$OutputDirectory = 'artifacts/windows-host')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($NodeDirectory) { $env:PATH = "$NodeDirectory;" + $env:PATH }
$env:VBOXMANAGE_PATH = Join-Path $env:ProgramFiles 'Oracle/VirtualBox/VBoxManage.exe'
Set-Location $root
Clear-Host
Write-Host 'VAMP WINDOWS HOST - REAL MCP STDIO TEST' -ForegroundColor Cyan
& .venv-virtualbox/Scripts/python.exe scripts/windows/host-smoke.py --output $OutputDirectory | Out-Null
if ($LASTEXITCODE) { throw 'Windows MCP smoke failed; inspect result.json' }
$report = Get-Content (Join-Path $OutputDirectory 'result.json') -Raw | ConvertFrom-Json
Write-Host "Host: $($report.host) / Python $($report.python)"
foreach ($check in $report.checks) { Write-Host "$($check.tool): $($check.result.status)" }
Write-Host 'WINDOWS MCP PASS - inventory, setup and SQLite history' -ForegroundColor Green
Write-Host 'REGISTERED INNER VMS:'
& $env:VBOXMANAGE_PATH list vms
