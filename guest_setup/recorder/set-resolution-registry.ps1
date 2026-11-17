param([int]$Width=1920,[int]$Height=1080)
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    $child=Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Unrestricted -File "'+$PSCommandPath+'" -Width '+$Width+' -Height '+$Height) -Wait -PassThru
    if($child.ExitCode -ne 0){throw 'Administrator registry update failed'}
    return
}
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force
if($Width -ne 1920 -or $Height -ne 1080){throw 'This helper sets the guest display to 1920x1080 only'}
$root='HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration'
$changes=@()
foreach($profile in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)){
    foreach($surface in @(Get-ChildItem -LiteralPath $profile.PSPath | Where-Object {$_.PSChildName -match '^\d{2}$'})){
        $changes+=@{Path=$surface.Name;Name='PrimSurfSize.cx';Value=$Width}
        $changes+=@{Path=$surface.Name;Name='PrimSurfSize.cy';Value=$Height}
        foreach($monitor in @(Get-ChildItem -LiteralPath $surface.PSPath | Where-Object {$_.PSChildName -match '^\d{2}$'})){
            $changes+=@{Path=$monitor.Name;Name='ActiveSize.cx';Value=$Width}
            $changes+=@{Path=$monitor.Name;Name='ActiveSize.cy';Value=$Height}
        }
    }
}
if($changes.Count -eq 0){throw 'No guest display configuration exists in the registry yet'}
$backupRoot=Join-Path $env:ProgramData 'VAMP\display-registry\backups'
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$backup=Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss-fffffff')+'.json')
$before=@(foreach($change in $changes){
    $key=Get-Item -LiteralPath ('Registry::'+$change.Path)
    $exists=$key.GetValueNames() -contains $change.Name
    @{Path=$change.Path;Name=$change.Name;Exists=$exists;Value=$key.GetValue($change.Name);Kind=$(if($exists){[string]$key.GetValueKind($change.Name)}else{$null})}
})
ConvertTo-Json -InputObject $before -Depth 5 | Set-Content -LiteralPath $backup -Encoding UTF8
foreach($change in $changes){
    $path='Registry::'+$change.Path
    New-ItemProperty -LiteralPath $path -Name $change.Name -Value $change.Value -PropertyType DWord -Force | Out-Null
    if((Get-ItemPropertyValue -LiteralPath $path -Name $change.Name) -ne $change.Value){throw "Registry verification failed: $($change.Name)"}
}
New-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name LogPixels -Value 96 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name Win8DpiScaling -Value 1 -PropertyType DWord -Force | Out-Null
Write-Host "Guest display registry values overwritten: 1920x1080. Backup: $backup"
