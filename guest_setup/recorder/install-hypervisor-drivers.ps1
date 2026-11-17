param([ValidateSet('virtualbox','kvm')][string]$Backend)
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Hypervisor drivers require administrator PowerShell'}
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force
$roots=Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root
$isoName=if($Backend -eq 'virtualbox'){'VBoxGuestAdditions.iso'}else{'virtio-win.iso'}
$media=$roots | ForEach-Object {Join-Path $_ $isoName} | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
if($media){Mount-DiskImage -ImagePath $media -StorageType ISO | Out-Null;$roots=Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root}
$logRoot=Join-Path $env:ProgramData 'VAMP-Packer'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
if($Backend -eq 'virtualbox'){
    $installer=$roots | ForEach-Object {Join-Path $_ 'VBoxWindowsAdditions.exe'} | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
    if(-not $installer){throw 'VirtualBox Guest Additions ISO is not attached'}
    $signature=Get-AuthenticodeSignature -LiteralPath $installer
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Oracle'){throw 'Guest Additions signature verification failed'}
    $process=Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if($process.ExitCode -notin @(0,3010)){throw "Guest Additions failed: $($process.ExitCode)"}
    @{status='installed';backend=$Backend;reboot_required=$true;installer=$installer}
}else{
    $installer=$roots | ForEach-Object {Join-Path $_ 'virtio-win-gt-x64.msi'} | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
    if(-not $installer){throw 'The virtio-win driver ISO is not attached'}
    $packages=@($installer)
    $agent=Join-Path (Split-Path $installer) 'guest-agent\qemu-ga-x86_64.msi'
    if(Test-Path -LiteralPath $agent){$packages+=$agent}
    foreach($package in $packages){
        $signature=Get-AuthenticodeSignature -LiteralPath $package
        if($signature.Status -ne 'Valid'){throw "VirtIO package signature verification failed: $package"}
        $log=Join-Path $logRoot ((Split-Path $package -Leaf)+'.log')
        $process=Start-Process msiexec.exe -ArgumentList @('/i',('"'+$package+'"'),'/qn','/norestart','REBOOT=ReallySuppress','/L*v',('"'+$log+'"')) -WindowStyle Hidden -Wait -PassThru
        if($process.ExitCode -notin @(0,3010)){throw "VirtIO guest package failed: $($process.ExitCode)"}
    }
    @{status='installed';backend=$Backend;reboot_required=$true;installer=$installer;guest_agent_installed=(Test-Path -LiteralPath $agent)}
}
