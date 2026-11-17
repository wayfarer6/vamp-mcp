# VAMP Windows postinstall, run at the first desktop login of the unattended account.
# It downloads and executes setup immediately in that user's session.
$ErrorActionPreference = 'Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    $payload='Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force; '
    if($PSCommandPath){$payload+="& '"+$PSCommandPath.Replace("'","''")+"'"}
    else {
        $origin=if($env:VAMP_SCRIPT_BASE_URL){$env:VAMP_SCRIPT_BASE_URL}else{'http://10.0.2.2:8421'}
        $payload+="irm '"+($origin+'/postwin.ps1').Replace("'","''")+"' | iex"
    }
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
    $elevated=Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Unrestricted','-EncodedCommand',$encoded) -Wait -PassThru
    if($elevated.ExitCode -ne 0){throw 'Administrator setup did not complete successfully'}
    return
}
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force

$base = if ($env:VAMP_SCRIPT_BASE_URL) { $env:VAMP_SCRIPT_BASE_URL } else { 'http://10.0.2.2:8421' }
$target = Join-Path $env:ProgramData 'RPA-Recorder-Setup'
New-Item -ItemType Directory -Force -Path $target | Out-Null

# SSH server: the host drives VAMP guests over SSH, so the server is installed,
# started at boot and reachable on port 22 before any recorder work is done.
# A guest without sshd cannot be provisioned from the host, so this is fatal.
if (-not (Get-Service -Name sshd -ErrorAction SilentlyContinue)) {
    $installed = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
            if ($capability -and $capability.State -ne 'Installed') {
                Add-WindowsCapability -Online -Name $capability.Name | Out-Null
            }
            if (Get-Service -Name sshd -ErrorAction SilentlyContinue) { $installed = $true; break }
        } catch {
            Write-Warning "OpenSSH Server install attempt $attempt failed: $_"
        }
        Start-Sleep -Seconds 15
    }
    if (-not $installed) {
        throw 'VAMP: OpenSSH Server could not be installed. SSH provisioning is required for VAMP guests; check that this guest reaches Windows Update.'
    }
}
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
$sshRoot = 'HKLM:\SOFTWARE\OpenSSH'
New-Item -Path $sshRoot -Force | Out-Null
$sshShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
New-ItemProperty -Path $sshRoot -Name DefaultShell -Value $sshShell -PropertyType String -Force | Out-Null
New-ItemProperty -Path $sshRoot -Name DefaultShellCommandOption -Value '/c' -PropertyType String -Force | Out-Null
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
} else {
    Enable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'
}
@{status='ready';port=22;default_shell=$sshShell;startup='Automatic';service=(Get-Service -Name sshd).Status.ToString()} |
    ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $target 'ssh-server.json')
$zip = Join-Path $env:TEMP 'vamp-guest-setup.zip'
$downloaded = $false
for ($attempt = 1; $attempt -le 15; $attempt++) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/vamp-guest-setup.zip" -OutFile $zip -TimeoutSec 30
        $downloaded = $true
        break
    } catch {
        if ($attempt -eq 15) {
            throw "VAMP: cannot download $base/vamp-guest-setup.zip during postinstall. Start the host script server on port 8421. $_"
        }
        Start-Sleep -Seconds 8
    }
}
if (-not $downloaded) { throw 'VAMP: setup bundle download failed' }
Expand-Archive -LiteralPath $zip -DestinationPath $target -Force

# Execute in this first desktop session rather than waiting for another login.
$log = Join-Path $target 'postinstall.log'
Start-Transcript -Path $log -Append
try {
    & (Join-Path $target 'recorder\setup.ps1')
    if (-not $?) { throw 'VAMP recorder setup failed' }
    @{status='completed';user=$env:USERNAME;completed_at=(Get-Date).ToString('o')} |
        ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $target 'postinstall-result.json')
} catch {
    @{status='failed';user=$env:USERNAME;error=$_.Exception.Message} |
        ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $target 'postinstall-result.json')
    throw
} finally {
    Stop-Transcript
}
