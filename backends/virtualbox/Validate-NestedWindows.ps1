# Run inside the explicitly requested disposable Windows hypervisor lab.
param([ValidateSet('Install','Create','Inspect','NativeBoot')][string]$Action,
      [string]$MediaRoot='D:\', [string]$Root='C:\VAMP-Lab',
      [string]$SourceVM='VAMP-Nested-Windows', [string]$Name='VAMP-VBox-Windows')
$ErrorActionPreference='Stop'
$binary='C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
function VBox {
    $savedPreference=$ErrorActionPreference
    try {
        # VBoxManage writes ordinary progress percentages to stderr on Windows.
        $ErrorActionPreference='Continue'
        $output=& $binary @args 2>&1
        $exitCode=$LASTEXITCODE
    } finally {$ErrorActionPreference=$savedPreference}
    if($exitCode -ne 0){throw ($output -join "`n")}
    return ($output -join "`n")
}
if($Action -eq 'Install') {
    if(@(Get-VM | Where-Object State -ne Off).Count){throw 'Shut down the Hyper-V test guest before installing the next hypervisor.'}
    if(-not(Test-Path $binary)) {
        $manifest=Get-Content -Raw (Join-Path $MediaRoot 'host-installers.json') | ConvertFrom-Json
        $installer=Join-Path $MediaRoot 'virtualbox.exe'
        if((Get-FileHash $installer -Algorithm SHA256).Hash -ne $manifest.virtualbox.sha256){throw 'VirtualBox installer checksum mismatch'}
        $p=Start-Process $installer -ArgumentList '--silent -msiparams REBOOT=ReallySuppress' -Wait -PassThru
        if($p.ExitCode -notin @(0,3010)){throw "VirtualBox installer failed: $($p.ExitCode)"}
    }
    Evidence 'VBoxInstall-passed' @{version=(VBox --version)}
} elseif($Action -eq 'Create') {
    if(@(Get-VM | Where-Object State -ne Off).Count){throw 'The source Hyper-V guest must be shut down before cloning its disk.'}
    $source=(Get-VMHardDiskDrive -VMName $SourceVM | Select-Object -First 1).Path
    $diskRoot=$Root
    $needed=(Get-Item $source).Length+2GB
    $data=Get-Volume -FileSystemLabel 'VAMP-Lab-Data' -ErrorAction SilentlyContinue
    if($data -or (Get-PSDrive C).Free -lt $needed) {
        if(-not $data) {
            $disk=Get-Disk -Number 0
            if($disk.LargestFreeExtent -lt $needed){throw 'Insufficient unallocated lab disk space for an independent clone.'}
            # Format only the newly allocated partition; existing recovery/data partitions remain intact.
            $partition=New-Partition -DiskNumber 0 -UseMaximumSize -AssignDriveLetter
            $data=$partition | Format-Volume -FileSystem NTFS -NewFileSystemLabel 'VAMP-Lab-Data' -Confirm:$false
        }
        $diskRoot=$data.DriveLetter+':\VAMP-Lab'
        New-Item -ItemType Directory -Force $diskRoot | Out-Null
    }
    if((Get-PSDrive ([IO.Path]::GetPathRoot($diskRoot).Substring(0,1))).Free -lt $needed){throw 'Insufficient lab data volume space for an independent clone.'}
    $destination=Join-Path $diskRoot 'VBox-Windows.vhd'
    if(Test-Path $destination){throw 'Clone destination already exists; it is preserved.'}
    Convert-VHD -Path $source -DestinationPath $destination -VHDType Dynamic
    $null=VBox createvm --name $Name --ostype Windows11_64 --basefolder (Join-Path $Root 'VirtualBox') --register
    $null=VBox modifyvm $Name --memory 4096 --cpus 2 --firmware efi --tpm-type 2.0 --ioapic on --graphicscontroller vboxsvga --vram 128 --usb-xhci on --mouse usbtablet --nic1 nat
    $null=VBox storagectl $Name --name SATA --add sata --controller IntelAhci
    $null=VBox storageattach $Name --storagectl SATA --port 0 --device 0 --type hdd --medium $destination
    $additions='C:\Program Files\Oracle\VirtualBox\VBoxGuestAdditions.iso'
    if(Test-Path $additions){$null=VBox storageattach $Name --storagectl SATA --port 1 --device 0 --type dvddrive --medium $additions}
    Evidence 'VBoxCreate-passed' @{name=$Name;independent_disk=$destination;source_disk_preserved=$source;memory_mb=4096;cpus=2}
} elseif($Action -eq 'Inspect') {
    Evidence 'VBoxInspect-passed' @{inventory=(VBox list vms);configuration=(VBox showvminfo $Name --machinereadable)}
} elseif($Action -eq 'NativeBoot') {
    $state=VBox showvminfo $Name --machinereadable
    if($state -match 'VMState="running"') {
        $null=VBox controlvm $Name acpipowerbutton
        $deadline=(Get-Date).AddSeconds(30)
        do {Start-Sleep -Seconds 1;$state=VBox showvminfo $Name --machinereadable} while($state -match 'VMState="running"' -and (Get-Date) -lt $deadline)
        if($state -match 'VMState="running"') {
            # This disposable clone was positively observed to be unresponsive.
            # Its original Hyper-V disk remains preserved separately.
            $null=VBox controlvm $Name poweroff
            Evidence 'VBoxFrozenClone-powered-off' @{name=$Name;reason='No visible response to keyboard/mouse; ACPI shutdown timed out';source_preserved=$true}
        }
    }
    # A one-time boot entry preserves the normal Hyper-V-enabled boot entry.
    $entryFile=Join-Path $Root 'vbox-one-time-boot.json'
    if(Test-Path $entryFile){throw 'A lab boot entry already exists; inspect it before another boot change.'}
    $output=& bcdedit.exe /copy '{current}' /d 'VAMP VirtualBox validation'
    if($LASTEXITCODE -ne 0){throw 'Could not create the one-time lab boot entry'}
    $id=[regex]::Match(($output -join ''),'\{[0-9a-fA-F-]{36}\}').Value
    if(-not $id){throw 'Could not identify the newly created boot entry'}
    @{id=$id;normal_entry_unchanged=$true} | ConvertTo-Json | Set-Content $entryFile
    & bcdedit.exe /set $id hypervisorlaunchtype off
    if($LASTEXITCODE -ne 0){throw 'Could not configure the one-time lab boot entry'}
    & bcdedit.exe /bootsequence $id
    if($LASTEXITCODE -ne 0){throw 'Could not select the one-time lab boot entry'}
    Evidence 'VBoxNativeBoot-requested' @{boot_entry=$id;normal_entry_unchanged=$true}
    Restart-Computer
}
