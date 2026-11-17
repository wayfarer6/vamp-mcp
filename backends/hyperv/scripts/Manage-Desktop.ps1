# Local UI lifecycle API. No generic PowerShell execution or embedded display.
param([Parameter(Mandatory=$true)][string]$RequestBase64,[Parameter(Mandatory=$true)][string]$StoragePath,[string]$LegacyStoragePath)
$ErrorActionPreference='Stop'
Import-Module Hyper-V -ErrorAction Stop
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
function Get-ManagedRecord([string]$Id) {
    foreach($root in @($StoragePath,$LegacyStoragePath)){
        if(-not $root -or -not(Test-Path -LiteralPath $root)){continue}
        foreach($file in Get-ChildItem -LiteralPath $root -Filter vamp-ui.json -Recurse -File){
            $item=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            if($item.id -eq $Id){return @{item=$item;folder=$file.DirectoryName;root=$root}}
        }
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
    'create' { throw 'VM installation uses backends/packer/runner.py; direct installation is retired' }
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
