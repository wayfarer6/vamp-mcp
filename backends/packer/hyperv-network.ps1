param([string]$SwitchName='Default Switch')
$ErrorActionPreference='Stop'
Import-Module Hyper-V
Get-VMHost | Out-Null
$switch=Get-VMSwitch -Name $SwitchName
$address=Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.InterfaceAlias -eq ('vEthernet ('+$switch.Name+')') -and $_.IPAddress -notlike '169.254.*'
} | Select-Object -First 1
if(-not $address){throw 'The selected Hyper-V switch has no guest-reachable host IPv4 address'}
@{switch=$switch.Name;host_ipv4=$address.IPAddress;switch_type=[string]$switch.SwitchType} | ConvertTo-Json -Compress
