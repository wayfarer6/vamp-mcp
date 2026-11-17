param([string]$Artifact,[string]$Destination,[string]$Name)
$ErrorActionPreference='Stop'
Import-Module Hyper-V
$config=Get-ChildItem -LiteralPath $Artifact -Recurse -Filter *.vmcx | Select-Object -First 1
if(-not $config){throw 'Packer did not export a Hyper-V configuration'}
$vm=Import-VM -Path $config.FullName -Copy -GenerateNewId -VirtualMachinePath $Destination -VhdDestinationPath $Destination
Rename-VM -VM $vm -NewName $Name
Start-VM -VM $vm
if([string](Get-VM -Id $vm.Id).State -ne 'Running'){throw 'Deployed VM did not reach Running state'}
$vm.Id.ToString()
