[CmdletBinding()]
param(
    [string]$VMName,
    [string]$Server = 'localhost',
    [switch]$StartVM,
    [string]$ResultPath,
    [string]$RequestBase64
)
$ErrorActionPreference = 'Stop'
if ($RequestBase64) {
    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
    $VMName = [string]$request.vm_name
    $Server = [string]$request.server
    $StartVM = [bool]$request.start_vm
    $ResultPath = [string]$request.result_path
}
function Quote-WindowsArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
$result = @{ backend='hyperv'; vm_name=$VMName; server=$Server; guest_connection_verified=$false }
try {
    if ([string]::IsNullOrWhiteSpace($VMName)) { throw 'VMName is required.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator token required. Use vmconnect.py to request normal UAC elevation.'
    }
    Import-Module Hyper-V -ErrorAction Stop
    # Get-VM -Name accepts wildcards. Require exact equality before any Start-VM.
    $selectedVMs = @(Get-VM -ComputerName $Server | Where-Object { $_.Name -ceq $VMName })
    if ($selectedVMs.Count -ne 1) { throw 'Expected exactly one VM with the exact requested name.' }
    $vm = $selectedVMs[0]
    $started = $false
    if ($vm.State -ne 'Running') {
        if (-not $StartVM) { throw 'VM is not running. Choose --start-vm to allow startup.' }
        if ($vm.State -ne 'Off') { throw 'VM state is not Off/Running; inspect it manually before startup.' }
        Start-VM -VM $vm -ErrorAction Stop | Out-Null
        $started = $true
        $deadline = (Get-Date).AddSeconds(60)
        do {
            Start-Sleep -Milliseconds 500
            $vm = Get-VM -ComputerName $Server | Where-Object { $_.Id -eq $vm.Id }
        } while ($vm.State -ne 'Running' -and (Get-Date) -lt $deadline)
        if ($vm.State -ne 'Running') { throw 'VM did not reach Running state within 60 seconds.' }
    }
    $binary = Join-Path $env:WINDIR 'System32\vmconnect.exe'
    if (-not (Test-Path -LiteralPath $binary)) { throw 'vmconnect.exe not found. Install the Hyper-V management tools.' }
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = $binary
    $processInfo.Arguments = (Quote-WindowsArgument $Server) + ' ' + (Quote-WindowsArgument $VMName)
    $processInfo.UseShellExecute = $false
    $process = [System.Diagnostics.Process]::Start($processInfo)
    if ($null -eq $process) { throw 'VMConnect process launch returned no process.' }
    $result.status = 'launch_requested'
    $result.verification = 'hyperv_vm_running_and_process_started'
    $result.vm_id = [string]$vm.Id
    $result.vm_started = $started
    $result.elevated = $true
    $result.vmconnect_pid = $process.Id
} catch {
    $result.status = 'error'
    $result.error_summary = $_.Exception.Message.Substring(0, [Math]::Min(300, $_.Exception.Message.Length))
}
$json = $result | ConvertTo-Json -Depth 5
if ($ResultPath) {
    $parent = Split-Path -Parent $ResultPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($ResultPath, $json, (New-Object Text.UTF8Encoding($false)))
}
Write-Output $json
if ($result.status -eq 'error') { exit 1 }
