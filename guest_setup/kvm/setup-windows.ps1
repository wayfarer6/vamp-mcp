# Runs once as the test desktop administrator after unattended Windows install.
$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\VAMP-Setup'
New-Item -ItemType Directory -Force -Path $root | Out-Null
Start-Transcript -Path (Join-Path $root 'setup.log') -Append
function Uart([string]$Message) {
    try {
        $port = [System.IO.Ports.SerialPort]::new('COM1',115200,[System.IO.Ports.Parity]::None,8,[System.IO.Ports.StopBits]::One)
        $port.Open(); $port.WriteLine($Message); $port.Close()
    } catch { Write-Warning "UART report unavailable: $_" }
}
function Run-Installer([string]$File, [string]$Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -Wait -PassThru
    if ($process.ExitCode -notin @(0,3010)) { throw "Installer exited with $($process.ExitCode): $File" }
}
try {
    @{status='running'} | ConvertTo-Json | Set-Content (Join-Path $root 'result.json')
    $manifest = Get-Content -Raw (Join-Path $root 'installers\manifest.json') | ConvertFrom-Json
    foreach ($name in @('python','keepassxc','veracrypt','virtio','vcredist')) {
        $info = $manifest.$name
        $file = Join-Path $root ('installers\'+[IO.Path]::GetFileName($info.path))
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $info.sha256) { throw "Checksum mismatch: $name" }
    }
    $vcRuntime = & (Join-Path $root 'vault\Install-VCRuntime.ps1') -InstallerPath (Join-Path $root 'installers\vcredist.exe') -ExpectedSha256 $manifest.vcredist.sha256
    if (-not (Get-Service -Name 'qemu-ga' -ErrorAction SilentlyContinue)) {
        Run-Installer (Join-Path $root 'installers\virtio.exe') '/quiet /norestart'
    }
    $python = 'C:\ProgramData\VAMP\Python312\python.exe'
    if (-not (Test-Path $python)) {
        Run-Installer (Join-Path $root 'installers\python.exe') '/quiet InstallAllUsers=1 TargetDir=C:\ProgramData\VAMP\Python312 Include_test=0 Include_launcher=0 PrependPath=0'
    }
    if (-not (Test-Path 'C:\Program Files\KeePassXC\keepassxc-proxy.exe')) {
        Run-Installer 'msiexec.exe' ('/i "'+$root+'\installers\keepassxc.msi" /qn /norestart /L*v "'+$root+'\keepassxc-install.log"')
    }
    if (-not (Test-Path 'C:\Program Files\VeraCrypt\VeraCrypt.exe')) {
        Run-Installer 'msiexec.exe' ('/i "'+$root+'\installers\veracrypt.msi" /qn /norestart ACCEPTLICENSE=YES /L*v "'+$root+'\veracrypt-install.log"')
    }
    & $python (Join-Path $root 'recorder\setup-user.py')
    if ($LASTEXITCODE -ne 0) { throw "Recorder setup failed: $LASTEXITCODE" }
    & (Join-Path $root 'vault\setup-guest-vault.ps1')
    $recorderPython = Join-Path ([Environment]::GetFolderPath('Desktop')) 'RPA-Recorder\.venv\Scripts\python.exe'
    & $recorderPython (Join-Path $root 'recorder\verify-recorder.py')
    if ($LASTEXITCODE -ne 0) { throw 'Recorder dependency verification failed' }
    $result = @{status='configured';python=$python;recorder_python=$recorderPython;keepassxc_proxy='C:\Program Files\KeePassXC\keepassxc-proxy.exe';veracrypt='C:\Program Files\VeraCrypt\VeraCrypt.exe';passkey_login_verified=$false}
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8
    Uart 'VAMP-WINDOWS-SETUP-CONFIGURED'
    Write-Output 'VAMP-WINDOWS-SETUP-CONFIGURED'
} catch {
    @{status='failed';error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8
    Uart 'VAMP-WINDOWS-SETUP-FAILED'
    throw
} finally { Stop-Transcript }
