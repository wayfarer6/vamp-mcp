# Provision a new nested Debian VM for remote MCP input validation.
param([string]$Name='VAMP-Remote-Debian')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root='C:\VAMP-RemoteLab'
$vbox='C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
if(& $vbox list vms | Select-String ('"'+[regex]::Escape($Name)+'"')){throw 'VM already exists; no replacement is allowed'}
$iso="$root\debian-auto.iso"
if(-not(Test-Path $iso)){Invoke-WebRequest http://10.0.2.2:8767/debian-auto.iso -OutFile $iso -UseBasicParsing}
function VBox {
 & $vbox @args
 if($LASTEXITCODE){throw "VBoxManage failed: $($args[0])"}
}
VBox createvm --name $Name --ostype Debian_64 --register
VBox modifyvm $Name --memory 3072 --cpus 2 --vram 128 --graphicscontroller vmsvga --firmware bios --nic1 nat --mouse usbtablet --usb-xhci on --boot1 dvd --boot2 disk --boot3 none --boot4 none
VBox createmedium disk --filename "$root\nested-debian.vdi" --size 24576 --format VDI
VBox storagectl $Name --name SATA --add sata --controller IntelAhci
VBox storageattach $Name --storagectl SATA --port 0 --device 0 --type hdd --medium "$root\nested-debian.vdi"
VBox storageattach $Name --storagectl SATA --port 1 --device 0 --type dvddrive --medium $iso
VBox startvm $Name --type headless
VBox showvminfo $Name --machinereadable
