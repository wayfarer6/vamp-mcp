# Integration runner for the explicitly requested disposable Windows lab.
param([ValidateSet('Prepare','Create','Inspect','Console','Transfer','Tools','Refresh','MCP','Vault','VaultMount','VSCode','Shutdown','VBoxInstall','VBoxCreate','VBoxInspect','VBoxNativeBoot','VBoxSdk','VBoxBoot','VBoxCapture','VBoxInput','VBoxTerminal','VBoxAdditions','VBoxDisplay','VBoxMouse','VBoxExchange')][string]$Phase='Inspect',
      [string]$MediaRoot='F:\', [string]$SetupRoot='D:\',
      [string]$Name='VAMP-Nested-Windows', [string]$Root='C:\VAMP-Lab', [int]$X=-1,[int]$Y=-1)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force $Root | Out-Null
function Evidence([string]$Stage,$Data) {
    $record=@{stage=$Stage;data=$Data;timestamp=(Get-Date).ToString('o')}
    $json=$record | ConvertTo-Json -Depth 8 -Compress
    $json | Set-Content (Join-Path $Root ($Stage+'.json')) -Encoding utf8
    $p=[IO.Ports.SerialPort]::new('COM1',115200)
    try {$p.Open();$p.WriteLine('VAMP-EVIDENCE '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))} finally {$p.Dispose()}
    Write-Output $json
}
function Export-LabPng([string]$Path) {
    $file=Get-Item -LiteralPath $Path
    if($file.Extension -ne '.png' -or $file.Length -gt 8MB){throw 'Expected a bounded lab screenshot'}
    # Preserve the original PNG; transfer a same-size JPEG preview over slow UART.
    Add-Type -AssemblyName System.Drawing
    $preview=[IO.Path]::ChangeExtension($Path,'.jpg')
    $image=[Drawing.Image]::FromFile($Path)
    $parameters=[Drawing.Imaging.EncoderParameters]::new(1)
    try {
        $parameters.Param[0]=[Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality,[long]75)
        $codec=[Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
        $image.Save($preview,$codec,$parameters)
    } finally {$image.Dispose();$parameters.Dispose()}
    $sha=(Get-FileHash -LiteralPath $preview -Algorithm SHA256).Hash.ToLowerInvariant()
    $data=[Convert]::ToBase64String([IO.File]::ReadAllBytes($preview))
    $p=[IO.Ports.SerialPort]::new('COM1',115200)
    try {$p.Open();$p.WriteLine('VAMP-IMG64 '+[IO.Path]::GetFileName($preview)+' '+$sha+' '+$data)} finally {$p.Dispose()}
}
try {
    Evidence ($Phase+'-started') @{vm=$Name}
    if($Phase -eq 'Prepare') {
        Expand-Archive -LiteralPath (Join-Path $MediaRoot 'vamp-source.zip') -DestinationPath (Join-Path $Root 'source') -Force
        $manifest=Get-Content -Raw (Join-Path $SetupRoot 'installers\manifest.json') | ConvertFrom-Json
        $runtime=& (Join-Path $Root 'source\guest_setup\vault\Install-VCRuntime.ps1') -InstallerPath (Join-Path $SetupRoot 'installers\vcredist.exe') -ExpectedSha256 $manifest.vcredist.sha256
        $version=& 'C:\Program Files\KeePassXC\keepassxc-cli.exe' --version 2>&1
        if($LASTEXITCODE -ne 0){throw 'KeePassXC CLI does not launch after runtime installation'}
        $python='C:\ProgramData\VAMP\Python312\python.exe'
        if(-not(Test-Path $python)){
            $installer=Join-Path $SetupRoot 'installers\python.exe'
            if((Get-FileHash $installer -Algorithm SHA256).Hash -ne $manifest.python.sha256){throw 'Python installer hash mismatch'}
            $p=Start-Process $installer -ArgumentList '/quiet InstallAllUsers=1 TargetDir=C:\ProgramData\VAMP\Python312 Include_test=0 Include_launcher=0 PrependPath=0' -Wait -PassThru
            if($p.ExitCode -notin @(0,3010)){throw 'Python installation failed'}
        }
        & $python -m venv (Join-Path $Root '.venv-hyperv')
        if($LASTEXITCODE -ne 0){throw 'Hyper-V venv creation failed'}
        & (Join-Path $Root '.venv-hyperv\Scripts\python.exe') -m pip install -r (Join-Path $Root 'source\backends\hyperv\requirements.txt')
        if($LASTEXITCODE -ne 0){throw 'Hyper-V requirements installation failed'}
        Evidence 'Prepare-passed' @{runtime=$runtime;keepassxc_version=[string]$version;python=$python}
    } elseif($Phase -eq 'Tools') {
        Expand-Archive -LiteralPath (Join-Path $MediaRoot 'vamp-source.zip') -DestinationPath (Join-Path $Root 'source') -Force
        $manifest=Get-Content -Raw (Join-Path $MediaRoot 'host-installers.json') | ConvertFrom-Json
        foreach($tool in @('node','vscode')) {
            $zip=Join-Path $MediaRoot ($tool+'.zip')
            if((Get-FileHash $zip -Algorithm SHA256).Hash -ne $manifest.$tool.sha256){throw "Checksum mismatch: $tool"}
            Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $Root $tool) -Force
        }
        $node=(Get-ChildItem (Join-Path $Root 'node') -Filter node.exe -Recurse | Select-Object -First 1).FullName
        $env:Path=(Split-Path $node)+';'+$env:Path
        $code=Join-Path $Root 'vscode\bin\code.cmd'
        foreach($vsix in @('vamp-mcp.vsix','vamp-vault.vsix')) {
            & $code --user-data-dir (Join-Path $Root 'vscode-profile') --extensions-dir (Join-Path $Root 'extensions') --install-extension (Join-Path $MediaRoot $vsix) --force
            if($LASTEXITCODE -ne 0){throw "VSIX installation failed: $vsix"}
        }
        $python=Join-Path $Root '.venv-hyperv\Scripts\python.exe'
        & $python -m pip install -r (Join-Path $Root 'source\requirements-mcp.txt')
        if($LASTEXITCODE -ne 0){throw 'MCP requirements installation failed'}
        & $node --version
        $extensions=& $code --user-data-dir (Join-Path $Root 'vscode-profile') --extensions-dir (Join-Path $Root 'extensions') --list-extensions --show-versions
        Evidence 'Tools-passed' @{node=$node;extensions=@($extensions)}
    } elseif($Phase -eq 'Refresh') {
        Expand-Archive -LiteralPath (Join-Path $MediaRoot 'vamp-source.zip') -DestinationPath (Join-Path $Root 'source') -Force
        $code=Join-Path $Root 'vscode\bin\code.cmd'
        foreach($vsix in @('vamp-mcp.vsix','vamp-vault.vsix')) {
            & $code --user-data-dir (Join-Path $Root 'vscode-profile') --extensions-dir (Join-Path $Root 'extensions') --install-extension (Join-Path $MediaRoot $vsix) --force
            if($LASTEXITCODE -ne 0){throw 'Updated VSIX installation failed'}
        }
        Evidence 'Refresh-passed' @{source='current validation media'}
    } elseif($Phase -in @('Vault','VaultMount')) {
        $python=Join-Path $Root '.venv-hyperv\Scripts\python.exe'
        $arguments=@((Join-Path $Root 'source\scripts\validate_windows_vault.py'),'--root',$Root)
        if($Phase -eq 'VaultMount') {
            $fixture=Join-Path $Root 'veracrypt-fixture.hc'
            if(-not(Test-Path $fixture)){Copy-Item (Join-Path $MediaRoot 'veracrypt-fixture.hc') $fixture}
            (Get-Item $fixture).IsReadOnly=$false
            $arguments+=@('--volume',$fixture)
        }
        $output=& $python @arguments
        if($LASTEXITCODE -ne 0){throw 'Native Windows Vault MCP verification failed'}
        Evidence ($Phase+'-passed') ($output | ConvertFrom-Json)
    } elseif($Phase -eq 'VSCode') {
        $code=Join-Path $Root 'vscode\bin\code.cmd'
        & $code --user-data-dir (Join-Path $Root 'vscode-profile') --extensions-dir (Join-Path $Root 'extensions') --extensionDevelopmentPath (Join-Path $Root 'source\scripts\vscode-probe') --extensionTestsPath (Join-Path $Root 'source\scripts\vscode-probe\test.cjs') --skip-welcome --skip-release-notes --disable-workspace-trust --wait
        if($LASTEXITCODE -ne 0){throw 'Real VS Code extension host test failed'}
        $report=Get-Content -Raw (Join-Path $Root 'vscode-native-result.json') | ConvertFrom-Json
        if($report.status -ne 'passed'){throw 'Real VS Code extension host report is not passed'}
        Evidence 'VSCode-passed' $report
    } elseif($Phase -eq 'MCP') {
        $python=Join-Path $Root '.venv-hyperv\Scripts\python.exe'
        $output=& $python (Join-Path $Root 'source\scripts\validate_windows_mcp.py')
        if($LASTEXITCODE -ne 0){throw 'Windows stdio MCP validation failed'}
        Evidence 'MCP-passed' ($output | ConvertFrom-Json)
    } elseif($Phase -eq 'Create') {
        $cpu=@(Get-CimInstance Win32_Processor)
        $memory=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
        $hostInfo=Get-VMHost
        if($cpu.Count -ne 1 -or ($cpu|Measure-Object NumberOfLogicalProcessors -Sum).Sum -ne 8){throw 'Unexpected CPU topology'}
        if($memory -lt 7.5GB -or $memory -gt 8.1GB){throw 'Unexpected memory size'}
        Evidence 'host-resources' @{sockets=$cpu.Count;cores=($cpu|Measure-Object NumberOfCores -Sum).Sum;memory_bytes=$memory;host=$hostInfo.Name}
        & (Join-Path $Root 'source\backends\hyperv\scripts\New-NestedWindowsGuest.ps1') -Name $Name -Root $Root -AnswerFile (Join-Path $MediaRoot 'nested-unattend.xml')
        Evidence 'Create-passed' (Get-VM -Name $Name | Select-Object Name,@{n='State';e={[string]$_.State}},Generation,ProcessorCount,MemoryAssigned)
    } elseif($Phase -eq 'Inspect') {
        Evidence 'Inspect-passed' @(Get-VM | Select-Object Name,@{n='State';e={[string]$_.State}},Generation,ProcessorCount,MemoryAssigned,Status)
    } elseif($Phase -eq 'Console') {
        & (Join-Path $Root '.venv-hyperv\Scripts\python.exe') -m robot --variable "VM_NAME:$Name" --outputdir (Join-Path $Root 'hyperv-report') (Join-Path $Root 'source\backends\hyperv\rpas\validation\run.robot')
        if($LASTEXITCODE -ne 0){throw 'Hyper-V Robot validation failed'}
        Evidence 'Console-passed' @{robot_exit_code=$LASTEXITCODE}
    } elseif($Phase -eq 'Transfer') {
        # Only the disposable guest's public unattended test account is used.
        # Override the credential UI for this integration test, never the transfer logic.
        [xml]$answer=Get-Content -Raw (Join-Path $MediaRoot 'nested-unattend.xml')
        $account=$answer.unattend.settings.component.UserAccounts.LocalAccounts.LocalAccount | Where-Object {$_}
        $script:labCredential=[pscredential]::new([string]$account.Name,(ConvertTo-SecureString ([string]$account.Password.Value) -AsPlainText -Force))
        function Get-Credential { param([string]$Message) return $script:labCredential }
        $session=$null
        try {
            $session=New-PSSession -VMName $Name -Credential $script:labCredential
            $guest=Invoke-Command -Session $session -ScriptBlock { @{computer=$env:COMPUTERNAME;os=(Get-CimInstance Win32_OperatingSystem).Caption} }
            $payload=Join-Path $Root 'payload.bin'
            $bytes=New-Object byte[] 8193
            [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
            [IO.File]::WriteAllBytes($payload,$bytes)
            $expected=(Get-FileHash $payload -Algorithm SHA256).Hash
            $worker=[scriptblock]::Create([IO.File]::ReadAllText((Join-Path $Root 'source\backends\hyperv\scripts\Transfer-HyperVFile.ps1')))
            function Transfer([string]$Direction,[string]$Local,[string]$Relative,[bool]$Overwrite=$false) {
                $resultPath=Join-Path $Root ('transfer-'+[guid]::NewGuid().ToString('N')+'.json')
                $request=@{vm_name=$Name;direction=$Direction;local_path=$Local;guest_path=$Relative;overwrite=$Overwrite;prompt_credentials=$true;result_path=$resultPath} | ConvertTo-Json -Compress
                & $worker -RequestBase64 ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($request)))
                return Get-Content -Raw $resultPath | ConvertFrom-Json
            }
            $relative='validation/'+[guid]::NewGuid().ToString('N')+'/payload.bin'
            $put=Transfer 'put' $payload $relative
            if($put.status -ne 'copied' -or -not $put.verified -or $put.sha256 -ne $expected -or $put.guest_path -isnot [string]){throw ('Host-to-guest transfer failed: '+($put | ConvertTo-Json -Compress))}
            $guestHash=Invoke-Command -Session $session -ArgumentList $relative -ScriptBlock {param($r) (Get-FileHash (Join-Path 'C:\Users\Public\VAMP-Exchange' $r) -Algorithm SHA256).Hash}
            if($guestHash -ne $expected){throw 'Guest did not read the uploaded bytes'}
            $blocked=Transfer 'put' $payload $relative
            if($blocked.status -ne 'error' -or $blocked.error_summary -notmatch 'exists'){throw 'Overwrite protection failed'}
            $escaped=Transfer 'put' $payload '../outside.bin'
            if($escaped.status -ne 'error' -or $escaped.error_summary -notmatch 'relative'){throw 'Path traversal protection failed'}
            $reply=$relative.Replace('payload.bin','guest-reply.bin')
            $replyHash=Invoke-Command -Session $session -ArgumentList $relative,$reply -ScriptBlock {
                param($r,$reply)
                $root='C:\Users\Public\VAMP-Exchange'
                $bytes=[IO.File]::ReadAllBytes((Join-Path $root $r));[Array]::Reverse($bytes)
                [IO.File]::WriteAllBytes((Join-Path $root $reply),$bytes)
                (Get-FileHash (Join-Path $root $reply) -Algorithm SHA256).Hash
            }
            $received=Join-Path $Root ('received-'+[guid]::NewGuid().ToString('N')+'.bin')
            $get=Transfer 'get' $received $reply
            if($get.status -ne 'copied' -or $get.sha256 -ne $replyHash -or (Get-FileHash $received -Algorithm SHA256).Hash -ne $replyHash){throw 'Guest-to-host transfer failed'}
            $blockedGet=Transfer 'get' $received $reply
            if($blockedGet.status -ne 'error' -or $blockedGet.error_summary -notmatch 'exists'){throw 'Host overwrite protection failed'}
            Evidence 'Transfer-passed' @{guest=$guest;put=$put;get=$get;bytes=8193;guest_read_verified=$true;guest_generated_reply=$true;overwrite_blocked=$true;traversal_blocked=$true}
        } finally {
            if($session){Remove-PSSession $session}
            Remove-Item Function:\Get-Credential -ErrorAction SilentlyContinue
            $script:labCredential=$null
        }
    } elseif($Phase -eq 'VBoxSdk') {
        $python=Join-Path $Root '.venv-hyperv\Scripts\python.exe'
        $manifest=Get-Content -Raw (Join-Path $MediaRoot 'host-installers.json') | ConvertFrom-Json
        $output=& $python (Join-Path $Root 'source\backends\virtualbox\setup_windows_sdk.py') --storage (Join-Path $Root 'sdk') --archive (Join-Path $MediaRoot 'vboxsdk.zip') --sha256 $manifest.vboxsdk.sha256
        if($LASTEXITCODE -ne 0){throw 'Matching Windows SDK installation failed'}
        Evidence 'VBoxSdk-passed' ($output | ConvertFrom-Json)
    } elseif($Phase -in @('VBoxBoot','VBoxCapture','VBoxInput','VBoxTerminal','VBoxAdditions','VBoxDisplay','VBoxMouse','VBoxExchange')) {
        $python=Join-Path $Root '.venv-hyperv\Scripts\python.exe'
        $arguments=@((Join-Path $Root 'source\scripts\validate_windows_virtualbox.py'),($Phase.Substring(4).ToLowerInvariant()),'--root',$Root)
        if($Phase -eq 'VBoxMouse'){$arguments+=@('--x',$X,'--y',$Y)}
        $output=& $python @arguments
        if($LASTEXITCODE -ne 0){throw 'Packaged VirtualBox MCP integration failed'}
        $report=$output | ConvertFrom-Json
        if($report.screenshot){Export-LabPng $report.screenshot}
        Evidence ($Phase+'-passed') $report
    } elseif($Phase -like 'VBox*') {
        & (Join-Path $Root 'source\backends\virtualbox\Validate-NestedWindows.ps1') -Action ($Phase.Substring(4)) -MediaRoot $MediaRoot -Root $Root -SourceVM $Name
    } elseif($Phase -eq 'Shutdown') {
        Stop-VM -Name $Name
        Evidence 'Shutdown-passed' (Get-VM -Name $Name | Select-Object Name,@{n='State';e={[string]$_.State}})
    }
} catch {
    Evidence ($Phase+'-failed') @{message=$_.Exception.Message;position=$_.InvocationInfo.PositionMessage}
    throw
}
