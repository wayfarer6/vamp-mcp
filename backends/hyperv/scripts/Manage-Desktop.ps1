# Local UI lifecycle API. No generic PowerShell execution or embedded display.
param([Parameter(Mandatory=$true)][string]$RequestBase64,[Parameter(Mandatory=$true)][string]$StoragePath)
$ErrorActionPreference='Stop'
Import-Module Hyper-V -ErrorAction Stop
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
function Get-ManagedRecord([string]$Id) {
    if(-not(Test-Path -LiteralPath $StoragePath)){return $null}
    foreach($file in Get-ChildItem -LiteralPath $StoragePath -Filter vamp-ui.json -Recurse -File){
        $item=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        if($item.id -eq $Id){return @{item=$item;folder=$file.DirectoryName}}
    }
    return $null
}
switch($request.action){
    'check' { Get-VMHost | Out-Null; @{status='ready'} | ConvertTo-Json -Compress }
    'list' {
        $rows=@(Get-VM | ForEach-Object {
            @{id=$_.Id.ToString();name=$_.Name;state=@{Running='running';Off='poweroff';Saved='saved';Paused='paused'}[[string]$_.State];memory=[int]($_.MemoryStartup/1MB);cpus=$_.ProcessorCount;backend='hyperv';managed=[bool](Get-ManagedRecord $_.Id.ToString())}
        })
        @{vms=$rows} | ConvertTo-Json -Depth 6 -Compress
    }
    'create' {
        $name=[string]$request.name
        if($name -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,62}$'){throw 'Invalid desktop name'}
        if(@(Get-VM | Where-Object Name -eq $name).Count){throw 'VM already exists'}
        $iso=[IO.Path]::GetFullPath([string]$request.iso_path)
        if(-not(Test-Path -LiteralPath $iso -PathType Leaf)){throw 'Choose a readable local ISO'}
        $memory=[int]$request.memory_mb; $cpus=[int]$request.cpus; $diskMB=[int]$request.disk_mb
        if($memory -lt 2048 -or $memory -gt 131072 -or $cpus -lt 1 -or $cpus -gt 64 -or $diskMB -lt 32768 -or $diskMB -gt 2097152){throw 'Invalid desktop resources'}
        $folder=Join-Path $StoragePath $name
        if(Test-Path -LiteralPath $folder){throw 'Desktop folder exists; no files will be replaced'}
        New-Item -ItemType Directory -Force -Path $StoragePath | Out-Null
        New-Item -ItemType Directory -Path $folder | Out-Null
        $disk=Join-Path $folder 'disk.vhdx'
        New-VHD -Path $disk -Dynamic -SizeBytes ([long]$diskMB*1MB) | Out-Null
        $vm=New-VM -Name $name -Generation 2 -MemoryStartupBytes ([long]$memory*1MB) -VHDPath $disk -Path $folder
        # Record ownership before further configuration, preserving recoverability.
        @{id=$vm.Id.ToString();name=$name;disk=$disk} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $folder 'vamp-ui.json')
        Set-VMProcessor -VM $vm -Count $cpus
        Set-VM -VM $vm -AutomaticStartAction Nothing -AutomaticStopAction ShutDown
        $switch=Get-VMSwitch | Where-Object Name -eq 'Default Switch' | Select-Object -First 1
        if($switch){Connect-VMNetworkAdapter -VMName $name -SwitchName $switch.Name}
        if($request.guest_os -eq 'windows11'){
            Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
            Enable-VMTPM -VM $vm
        } else {Set-VMFirmware -VM $vm -EnableSecureBoot Off}
        $dvd=Add-VMDvdDrive -VM $vm -Path $iso -Passthru
        Set-VMFirmware -VM $vm -FirstBootDevice $dvd
        $mode='manual'
        $base=$null
        if($request.guest_os -eq 'debian'){
            if(-not $switch){throw 'Debian autoinstall needs the Hyper-V Default Switch'}
            $address=Get-NetIPAddress -AddressFamily IPv4 | Where-Object InterfaceAlias -eq ('vEthernet ('+$switch.Name+')') | Select-Object -First 1
            if(-not $address){throw 'No host IPv4 address on Default Switch'}
            $base='http://'+$address.IPAddress+':8421'
            $mode='unattended'
        }
        Start-VM -VM $vm
        . (Join-Path $PSScriptRoot 'Send-InstallerBoot.ps1')
        Invoke-HyperVInstallerBoot -VM $vm -GuestOS $request.guest_os -BaseUrl $base
        @{status='installation_started';installation_mode=$mode;installation_verified=$false;guest_setup_base_url=$base;id=$vm.Id.ToString();vm=$name;embedded_display_supported=$false;network_connected=[bool]$switch} | ConvertTo-Json -Compress
    }
    {$_ -in 'start','stop','delete'} {
        $id=[guid]$request.id
        $vm=Get-VM -Id $id
        if($request.action -eq 'start'){Start-VM -VM $vm}
        if($request.action -eq 'stop'){Stop-VM -VM $vm -Confirm:$false}
        if($request.action -eq 'delete'){
            if([string]$vm.State -ne 'Off'){throw 'Shut down the VM before deleting it'}
            $record=Get-ManagedRecord $id.ToString()
            if(-not $record){throw 'Only desktops created by VAMP can be deleted here'}
            Remove-VM -VM $vm -Force
            Remove-Item -LiteralPath $record.folder -Recurse -Force
        }
        @{status='requested'} | ConvertTo-Json -Compress
    }
    default {throw 'Unsupported desktop action'}
}
