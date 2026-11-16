# Disposable nested Windows lab only. Does not disable UAC or enable Hyper-V.
param([Parameter(Mandatory=$true)][string]$MediaRoot)
$ErrorActionPreference='Stop'
$root='C:\VAMP-RemoteLab'
New-Item -ItemType Directory -Force $root | Out-Null
Start-Transcript "$root\prepare.log" -Append
try {
    Expand-Archive "$MediaRoot\source.zip" "$root\source" -Force
    $manifest=Get-Content -Raw "$MediaRoot\manifest.json" | ConvertFrom-Json
    foreach($name in @('node','virtualbox','vboxsdk')) {
        $file=Join-Path $MediaRoot ([IO.Path]::GetFileName($manifest.$name.path))
        if((Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.$name.sha256){throw "Checksum mismatch: $name"}
    }
    Expand-Archive "$MediaRoot\node.zip" "$root\node" -Force
    $vbox='C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
    if(-not(Test-Path $vbox)) {
        $p=Start-Process "$MediaRoot\virtualbox.exe" -ArgumentList '--silent -msiparams REBOOT=ReallySuppress' -Wait -PassThru
        if($p.ExitCode -notin @(0,3010)){throw "VirtualBox installer failed: $($p.ExitCode)"}
    }
    $python='C:\ProgramData\VAMP\Python312\python.exe'
    & $python -m venv "$root\python"
    if($LASTEXITCODE){throw 'Host venv creation failed'}
    & "$root\python\Scripts\python.exe" "$root\source\backends\virtualbox\setup_windows_sdk.py" --storage "$root\sdk" --archive "$MediaRoot\vboxsdk.zip" --sha256 $manifest.vboxsdk.sha256
    if($LASTEXITCODE){throw 'VirtualBox SDK setup failed'}
    $node=(Get-ChildItem "$root\node" -Filter node.exe -Recurse | Select-Object -First 1).FullName
    $cpu=@(Get-CimInstance Win32_Processor)
    $info=@{status='prepared';node=$node;python="$root\python\Scripts\python.exe";vbox=(& $vbox --version);sockets=$cpu.Count;cores=($cpu|Measure-Object NumberOfCores -Sum).Sum;memory_bytes=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory}
    $info | ConvertTo-Json | Set-Content "$root\result.json"
} finally {Stop-Transcript}
