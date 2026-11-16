# Explicitly requested disposable Windows nested-hypervisor lab provisioning.
# Run in an administrator PowerShell; never approves UAC or changes UAC policy.
param([string]$MediaRoot)
$ErrorActionPreference='Stop'
$root='C:\VAMP-Lab'
New-Item -ItemType Directory -Force $root | Out-Null
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this script in an administrator PowerShell.'}
Start-Transcript -Path "$root\provision.log" -Append
function Report([string]$Status,[string]$Detail='') {
    @{status=$Status;detail=$Detail;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content "$root\provision-result.json"
    try {$p=[IO.Ports.SerialPort]::new('COM1',115200);$p.Open();$p.WriteLine('VAMP-NESTED-LAB-'+$Status.ToUpperInvariant());$p.Close()}catch{}
}
try {
    if(-not $MediaRoot){$MediaRoot=(Get-CimInstance Win32_LogicalDisk | Where-Object {Test-Path ($_.DeviceID+'\setup-windows.ps1')} | Select-Object -First 1).DeviceID+'\'}
    if(-not(Test-Path "$MediaRoot\setup-windows.ps1")){throw 'Verified VAMP setup media not found'}
    Report 'preparing'
    Copy-Item "$MediaRoot\*" 'C:\ProgramData\VAMP-Setup' -Recurse -Force
    try { & 'C:\ProgramData\VAMP-Setup\setup-windows.ps1' } catch { $_ | Out-String | Set-Content "$root\guest-setup-error.txt" }
    $hardware=Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,VirtualizationFirmwareEnabled,SecondLevelAddressTranslationExtensions
    $hardware | ConvertTo-Json | Set-Content "$root\cpu.json"
    if((($hardware | Measure-Object NumberOfLogicalProcessors -Sum).Sum) -ne 8){throw 'Expected 8 logical processors'}
    if(@($hardware).Count -ne 1){throw 'Expected one CPU socket'}
    $memory=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    if($memory -lt 7.5GB -or $memory -gt 8.1GB){throw 'Expected 8 GiB RAM'}
    $feature=Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart
    if((Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State -ne 'Enabled'){throw 'Hyper-V feature did not enable'}
    Report 'reboot_required'
    Write-Output 'Hyper-V enabled. Restart Windows before running the nested scenarios.'
} catch {Report 'failed' $_.Exception.Message;throw} finally {Stop-Transcript}
