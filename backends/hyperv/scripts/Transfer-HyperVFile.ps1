param([Parameter(Mandatory=$true)][string]$RequestBase64)
$ErrorActionPreference='Stop'
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
$resultPath=$request.result_path
$session=$null
try {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=[Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Hyper-V transfer requires an administrator PowerShell host.' }
    $vm=@(Get-VM | Where-Object { $_.Name -ceq $request.vm_name })
    if ($vm.Count -ne 1) { throw 'Exactly one matching VM is required.' }
    if ($vm[0].State -ne 'Running') { throw 'The selected VM must already be running.' }
    if (-not $request.prompt_credentials) {
        $result=@{status='needs_credentials';backend='hyperv';credential_source='private_windows_dialog'}
    } else {
        # No password in argv, JSON, transcript, MCP output, or persistent files.
        $credential=Get-Credential -Message ('Guest credentials for '+$request.vm_name)
        if (-not $credential) { throw 'The private credential dialog was cancelled.' }
        $session=New-PSSession -VMId $vm[0].Id -Credential $credential
        $credential=$null
        $relative=[string]$request.guest_path
        if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)' -or $relative.Contains(':')) { throw 'Use a relative exchange path.' }
        $target=[string](Invoke-Command -Session $session -ArgumentList $relative -ScriptBlock {
            param($relative)
            $root='C:\Users\Public\VAMP-Exchange'
            New-Item -ItemType Directory -Force $root | Out-Null
            $path=[IO.Path]::GetFullPath((Join-Path $root $relative))
            if (-not $path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Guest path escapes the exchange folder.' }
            New-Item -ItemType Directory -Force (Split-Path -Parent $path) | Out-Null
            $path
        })
        if ($request.direction -eq 'put') {
            $source=Get-Item -LiteralPath $request.local_path
            if ($source.PSIsContainer -or $source.Length -gt 1GB) { throw 'Choose a file no larger than 1 GiB.' }
            $exists=Invoke-Command -Session $session -ArgumentList $target -ScriptBlock { param($p) Test-Path -LiteralPath $p }
            if ($exists -and -not $request.overwrite) { throw 'Guest destination exists; overwrite was not requested.' }
            $temporary=$target+'.vamp-'+[Guid]::NewGuid().ToString('N')
            Copy-Item -LiteralPath $source.FullName -Destination $temporary -ToSession $session
            $sha=(Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash
            $remote=Invoke-Command -Session $session -ArgumentList $temporary,$target,([bool]$request.overwrite) -ScriptBlock {
                param($temporary,$target,[bool]$overwrite)
                try {
                    $hash=(Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash
                    Move-Item -LiteralPath $temporary -Destination $target -Force:$overwrite
                    @{sha256=$hash;bytes=(Get-Item -LiteralPath $target).Length}
                } finally { if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force} }
            }
            if ($remote.sha256 -ne $sha) { throw 'Transferred file checksum mismatch.' }
            $result=@{status='copied';backend='hyperv';direction='host_to_guest';guest_path=$target;bytes=$remote.bytes;sha256=$sha.ToLowerInvariant();verified=$true}
        } elseif ($request.direction -eq 'get') {
            $destination=[IO.Path]::GetFullPath($request.local_path)
            if ((Test-Path -LiteralPath $destination) -and -not $request.overwrite) { throw 'Host destination exists; overwrite was not requested.' }
            $metadata=Invoke-Command -Session $session -ArgumentList $target -ScriptBlock {
                param($p)
                $file=Get-Item -LiteralPath $p
                if ($file.PSIsContainer -or $file.Length -gt 1GB) { throw 'Choose a file no larger than 1 GiB.' }
                @{bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash}
            }
            New-Item -ItemType Directory -Force (Split-Path -Parent $destination) | Out-Null
            $temporary=$destination+'.vamp-'+[Guid]::NewGuid().ToString('N')
            try {
                Copy-Item -LiteralPath $target -Destination $temporary -FromSession $session
                $sha=(Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash
                if ($sha -ne $metadata.sha256) { throw 'Transferred file checksum mismatch.' }
                Move-Item -LiteralPath $temporary -Destination $destination -Force:([bool]$request.overwrite)
            } finally {if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
            $result=@{status='copied';backend='hyperv';direction='guest_to_host';local_path=$destination;bytes=$metadata.bytes;sha256=$sha.ToLowerInvariant();verified=$true}
        } else { throw 'Unknown transfer direction.' }
    }
} catch { $result=@{status='error';backend='hyperv';error_summary=$_.Exception.Message} }
finally { if($session){Remove-PSSession $session} }
$folder=Split-Path -Parent $resultPath
New-Item -ItemType Directory -Force $folder | Out-Null
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath ($resultPath+'.tmp') -Encoding utf8
Move-Item -LiteralPath ($resultPath+'.tmp') -Destination $resultPath -Force
