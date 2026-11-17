# Guest-only interactive automation policy. Never run this on the host.
$ErrorActionPreference='Stop'
foreach($setting in @('monitor-timeout-ac','monitor-timeout-dc','standby-timeout-ac','standby-timeout-dc','hibernate-timeout-ac','hibernate-timeout-dc')) {
    & powercfg.exe /change $setting 0
    if($LASTEXITCODE -ne 0){throw "Cannot disable guest power timeout: $setting"}
}
foreach($key in @('HKCU:\Control Panel\Desktop','HKCU:\Software\Policies\Microsoft\Windows\Control Panel\Desktop')) {
    New-Item -Path $key -Force | Out-Null
    foreach($name in @('ScreenSaveActive','ScreenSaverIsSecure')){Set-ItemProperty -Path $key -Name $name -Value '0'}
}
$key='HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Winlogon'
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name EnableGoodbye -PropertyType DWord -Value 0 -Force | Out-Null
Write-Output 'VAMP: guest display/sleep timeouts and automatic screensaver locking disabled.'
