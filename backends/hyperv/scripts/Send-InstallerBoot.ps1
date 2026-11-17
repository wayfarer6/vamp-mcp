# Hyper-V synthetic keyboard adapter; never sends input to host windows.
function Invoke-HyperVInstallerBoot {
    param($VM,[string]$GuestOS,[string]$BaseUrl)
    $profile=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../common/guest-install.json') -Raw | ConvertFrom-Json
        Start-Sleep -Seconds $profile.boot_wait_seconds
        # Synthetic keyboard targets this VM directly, without host window focus.
        $system=Get-CimInstance -Namespace root/virtualization/v2 -ClassName Msvm_ComputerSystem -Filter ("Name='"+$VM.Id.ToString()+"'")
        $keyboard=Get-CimAssociatedInstance -InputObject $system -ResultClassName Msvm_Keyboard
        if(-not $keyboard){throw 'Hyper-V synthetic keyboard unavailable; inspect VMConnect'}
        function Send-Text([string]$Text){
            $r=Invoke-CimMethod -InputObject $keyboard -MethodName TypeText -Arguments @{asciiText=$Text}
            if($r.ReturnValue -ne 0){throw 'Hyper-V keyboard text dispatch failed'}
        }
        function Send-Enter {
            $r=Invoke-CimMethod -InputObject $keyboard -MethodName TypeKey -Arguments @{keyCode=[uint32]13}
            if($r.ReturnValue -ne 0){throw 'Hyper-V Enter dispatch failed'}
        }
        if($GuestOS -eq 'debian'){
            foreach($step in $profile.debian.efi_boot){
                if($step.kind -eq 'wait'){Start-Sleep -Seconds $step.seconds}
                if($step.kind -in 'text','line'){Send-Text ($step.text.Replace('{base_url}',$BaseUrl))}
                if($step.kind -in 'line','enter'){Send-Enter}
            }
        } else {Send-Enter}
}
