param([string]$SwitchName='Default Switch',[string]$BootstrapHost='')
$ErrorActionPreference='Stop'
Import-Module Hyper-V
Get-VMHost | Out-Null
$switches=@(Get-VMSwitch -Name $SwitchName)
if($switches.Count -ne 1 -or $switches[0].Name -ne $SwitchName){throw 'Exactly one explicitly selected Hyper-V switch is required'}
$switch=$switches[0]
$addresses=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.InterfaceAlias -eq ('vEthernet ('+$switch.Name+')') -and
    $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource -and
    $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '127.*' -and
    $_.IPAddress -ne '0.0.0.0'
} | Select-Object -ExpandProperty IPAddress -Unique)
if($BootstrapHost){
    if($addresses -notcontains $BootstrapHost){throw 'Requested bootstrap host is not a usable address of the selected Hyper-V switch'}
    $addresses=@($BootstrapHost)
}
if($addresses.Count -ne 1){throw 'The selected Hyper-V switch must have exactly one usable guest-reachable host IPv4 address; none or ambiguous addresses are refused'}
@{switch=$switch.Name;host_ipv4=$addresses[0];host_ipv4_candidates=$addresses;switch_type=[string]$switch.SwitchType} | ConvertTo-Json -Compress
