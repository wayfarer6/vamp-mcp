# Install the display reset shortcuts only; do not change the current resolution.
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    $payload='Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force; '
    if($PSCommandPath){$payload+="& '"+$PSCommandPath.Replace("'","''")+"'"}
    else {
        $origin=if($env:VAMP_SCRIPT_BASE_URL){$env:VAMP_SCRIPT_BASE_URL}else{'http://10.0.2.2:8421'}
        $payload+="irm '"+($origin+'/recorder/install-resolution-shortcut.ps1').Replace("'","''")+"' | iex"
    }
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
    $elevated=Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Unrestricted','-EncodedCommand',$encoded) -Wait -PassThru
    if($elevated.ExitCode -ne 0){throw 'Administrator setup did not complete successfully'}
    return
}
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force

$base=if($env:VAMP_SCRIPT_BASE_URL){$env:VAMP_SCRIPT_BASE_URL}else{'http://10.0.2.2:8421'}
$desktop=[Environment]::GetFolderPath('Desktop')
$candidates=@((Join-Path $desktop 'RPA-Recorder\.venv\Scripts\python.exe'))
$pythonRoot=Join-Path $env:LOCALAPPDATA 'Programs\Python'
if(Test-Path -LiteralPath $pythonRoot){
    $candidates+=Get-ChildItem -LiteralPath $pythonRoot -Directory -Filter 'Python3*' | Sort-Object Name -Descending | ForEach-Object {Join-Path $_.FullName 'python.exe'}
}
$python=$candidates | Where-Object {Test-Path -LiteralPath $_ -PathType Leaf} | Select-Object -First 1
if(-not $python){throw 'Python from guest setup was not found. Finish VAMP guest setup first.'}
$work=Join-Path $env:TEMP ('vamp-resolution-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
foreach($name in @('apply-display.py','windows-display.py','gnome-display.py','session-policy.py','install-display-startup.py')){
    Invoke-WebRequest -UseBasicParsing -Uri "$base/recorder/$name" -OutFile (Join-Path $work $name)
}
& $python (Join-Path $work 'install-display-startup.py') --desktop $desktop
if($LASTEXITCODE -ne 0){throw 'Resolution shortcut installation failed'}
Write-Host 'Installed on the Desktop: Set-Resolution-1920x1080.cmd and Set-Resolution-1920x1080.ps1'
Write-Host 'Double-click Set-Resolution-1920x1080.cmd to apply Full HD when needed.'
Write-Host 'The current display resolution has not been changed.'
