# Prepare one disposable Windows guest using the local Windows installation DVD.
# Run after the lab host has rebooted with Hyper-V enabled.
param([string]$Name='VAMP-Nested-Windows',[string]$Root='C:\VAMP-Lab',[string]$AnswerFile)
$ErrorActionPreference='Stop'
if(Get-VM -Name $Name -ErrorAction SilentlyContinue){throw 'VM exists; no disk or VM is replaced.'}
if(@(Get-VM | Where-Object State -eq Running).Count){throw 'Stop the other nested VM before provisioning.'}
$source=Get-CimInstance Win32_LogicalDisk | Where-Object {Test-Path ($_.DeviceID+'\sources\install.wim')} | Select-Object -First 1
if(-not $source){throw 'Attach the Windows installation ISO to the outer lab VM.'}
if(-not(Test-Path -LiteralPath $AnswerFile)){throw 'An explicit lab unattended answer file is required.'}
New-Item -ItemType Directory -Force $Root | Out-Null
$vhd=Join-Path $Root ($Name+'.vhdx')
if(Test-Path -LiteralPath $vhd){throw 'Disk already exists; no existing image is replaced.'}
$mounted=$false
try {
    New-VHD -Path $vhd -Dynamic -SizeBytes 64GB | Out-Null
    $disk=Mount-VHD -Path $vhd -Passthru | Get-Disk
    $mounted=$true
    Initialize-Disk -Number $disk.Number -PartitionStyle GPT
    $efi=New-Partition -DiskNumber $disk.Number -Size 260MB -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}' -AssignDriveLetter
    $efi | Format-Volume -FileSystem FAT32 -NewFileSystemLabel VAMP-EFI -Confirm:$false | Out-Null
    New-Partition -DiskNumber $disk.Number -Size 16MB -GptType '{e3c9e316-0b5c-4db8-817d-f92df00215ae}' | Out-Null
    $os=New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
    $os | Format-Volume -FileSystem NTFS -NewFileSystemLabel VAMP-Windows -Confirm:$false | Out-Null
    $apply=$os.DriveLetter+':\'
    Expand-WindowsImage -ImagePath ($source.DeviceID+'\sources\install.wim') -Index 3 -ApplyPath $apply -CheckIntegrity | Out-Null
    New-Item -ItemType Directory -Force ($apply+'Windows\Panther') | Out-Null
    Copy-Item -LiteralPath $AnswerFile -Destination ($apply+'Windows\Panther\unattend.xml')
    & bcdboot.exe ($apply+'Windows') /s ($efi.DriveLetter+':') /f UEFI
    if($LASTEXITCODE -ne 0){throw 'BCD boot preparation failed'}
} finally {if($mounted){Dismount-VHD -Path $vhd}}
$vm=New-VM -Name $Name -Generation 2 -MemoryStartupBytes 4GB -VHDPath $vhd
Set-VMProcessor -VMName $Name -Count 2
Set-VM -VMName $Name -AutomaticStartAction Nothing -AutomaticStopAction ShutDown
Set-VMFirmware -VMName $Name -EnableSecureBoot On
Set-VMKeyProtector -VMName $Name -NewLocalKeyProtector
Enable-VMTPM -VMName $Name
Start-VM -Name $Name
@{status='boot_requested';vm_name=$Name;id=$vm.Id.ToString();installation_verified=$false;memory_mb=4096;cpus=2} | ConvertTo-Json | Set-Content (Join-Path $Root 'nested-create.json')
