"""Packer owns ISO boot, hardware creation, installation wait and golden export."""
import json
from pathlib import Path
from xml.sax.saxutils import escape
from toolchain import POLICY,answer_iso

ROOT=Path(__file__).resolve().parents[2]

SSH_PACKAGE='openssh-server'


def ensure_openssh_preseed(text):
    """A VAMP guest answers SSH, so every rendered preseed carries the server."""
    lines=[line for line in text.splitlines() if not line.startswith('d-i preseed/late_command')]
    found=False
    for index,line in enumerate(lines):
        if not line.startswith('d-i pkgsel/include'):continue
        found=True
        packages=line.split()
        if SSH_PACKAGE not in packages:
            lines[index]=line.rstrip()+' '+SSH_PACKAGE
    if not found:lines.append('d-i pkgsel/include string '+SSH_PACKAGE)
    return '\n'.join(lines)

def windows_postinstall(base,callback,backend='virtualbox'):
    script=r'''$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Unrestricted -File "'+$PSCommandPath+'"') -Wait -PassThru
 exit $child.ExitCode
}
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force
$state=Join-Path $env:ProgramData 'VAMP-Packer'
New-Item -ItemType Directory -Force -Path $state | Out-Null
Start-Transcript -Path (Join-Path $state 'postinstall.log') -Append
try {
 Start-Sleep -Seconds 60
 $env:VAMP_SCRIPT_BASE_URL='__BASE__'
 $backend='__BACKEND__'
 $driverMarker=Join-Path $state 'drivers-installed.json'
 if(-not(Test-Path -LiteralPath $driverMarker)){
  $entry=Join-Path $env:TEMP 'vamp-postwin.ps1'
  Invoke-WebRequest -UseBasicParsing '__BASE__/postwin.ps1' -OutFile $entry
  & $entry
  if($backend -in @('virtualbox','kvm')){
   $install=Join-Path $env:ProgramData 'RPA-Recorder-Setup\recorder\install-hypervisor-drivers.ps1'
   $drivers=& $install -Backend $backend
   $drivers | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $driverMarker
   $resume=Join-Path $state 'resume-postinstall.ps1'
   Copy-Item -LiteralPath $PSCommandPath -Destination $resume -Force
   $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Unrestricted -File "'+$resume+'"')
   $trigger=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   $principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
   Register-ScheduledTask -TaskName 'VAMP-Packer-Finish' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
   $login='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
   foreach($item in (@{AutoAdminLogon='1';DefaultUserName='vboxuser';DefaultPassword='password123!';DefaultDomainName=$env:COMPUTERNAME}).GetEnumerator()){
    New-ItemProperty -Path $login -Name $item.Key -Value $item.Value -PropertyType String -Force | Out-Null
   }
   Remove-ItemProperty -Path $login -Name 'AutoLogonCount' -ErrorAction SilentlyContinue
   New-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name LogPixels -Value 96 -PropertyType DWord -Force | Out-Null
   shutdown.exe /r /t 10
   return
  }
 }
 if($backend -eq 'virtualbox' -and -not(Get-Service VBoxService -ErrorAction SilentlyContinue)){throw 'Guest Additions service is missing after reboot'}
 $ssh=Get-Service -Name sshd -ErrorAction SilentlyContinue
 if(-not $ssh){throw 'OpenSSH Server service is missing after guest setup'}
 if($ssh.StartType -ne 'Automatic'){Set-Service -Name sshd -StartupType Automatic}
 if($ssh.Status -ne 'Running'){Start-Service sshd}
 if(-not(Get-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell){throw 'OpenSSH DefaultShell is not configured after guest setup'}
 if(-not(Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)){throw 'OpenSSH inbound firewall rule is missing after guest setup'}
 $reset=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Set-Resolution-1920x1080.ps1'
 if(Test-Path -LiteralPath $reset){& $reset;if(-not $?){throw 'Full HD display setup failed'}}
 @{status='completed';drivers_rebooted=(Test-Path -LiteralPath $driverMarker)} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $state 'completed.json')
 Invoke-WebRequest -UseBasicParsing -Method POST '__CALLBACK__' | Out-Null
 Unregister-ScheduledTask -TaskName 'VAMP-Packer-Finish' -Confirm:$false -ErrorAction SilentlyContinue
} finally { Stop-Transcript }
shutdown.exe /s /t 10
'''
    return script.replace('__BASE__',base).replace('__CALLBACK__',callback).replace('__BACKEND__',backend)


def windows_answer(base,callback,image_index,language="en-US",product_key=""):
    # FirstLogonCommands.CommandLine is limited to 1024 characters. Keep the
    # actual setup code on the answer ISO and execute it through a short launcher.
    command='cmd.exe /c for %d in (D E F G H I J K L M N O P Q R S T U V W X Y Z) do @if exist %d:\\vamp-postinstall.ps1 powershell.exe -NoProfile -ExecutionPolicy Unrestricted -File %d:\\vamp-postinstall.ps1'
    component=lambda name,content: '<component name="'+name+'" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">'+content+'</component>'
    locale='<InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>'
    partitions=''.join(f'<CreatePartition wcm:action="add"><Order>{i}</Order><Type>{kind}</Type>{"<Extend>true</Extend>" if not size else "<Size>"+str(size)+"</Size>"}</CreatePartition>' for i,kind,size in [(1,'EFI',100),(2,'MSR',16),(3,'Primary',0)])
    modify='<ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition><ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>'
    setup=f'<DiskConfiguration><Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions>{partitions}</CreatePartitions><ModifyPartitions>{modify}</ModifyPartitions></Disk></DiskConfiguration><ImageInstall><OSImage><InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>{image_index}</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo><WillShowUI>OnError</WillShowUI></OSImage></ImageInstall><UserData><ProductKey><Key>{escape(product_key)}</Key><WillShowUI>OnError</WillShowUI></ProductKey><AcceptEula>true</AcceptEula><FullName>VAMP</FullName><Organization>VAMP</Organization></UserData>'
    shell='<OOBE><HideEULAPage>true</HideEULAPage><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE><UserAccounts><LocalAccounts><LocalAccount wcm:action="add"><Name>vboxuser</Name><Group>Administrators</Group><Password><Value>password123!</Value><PlainText>true</PlainText></Password></LocalAccount></LocalAccounts></UserAccounts><AutoLogon><Username>vboxuser</Username><Enabled>true</Enabled><LogonCount>1</LogonCount><Password><Value>password123!</Value><PlainText>true</PlainText></Password></AutoLogon><FirstLogonCommands><SynchronousCommand wcm:action="add"><Order>1</Order><Description>VAMP Packer guest setup</Description><CommandLine>'+escape(command)+'</CommandLine></SynchronousCommand></FirstLogonCommands>'
    return ('<?xml version="1.0" encoding="utf-8"?><unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><settings pass="windowsPE">'+component('Microsoft-Windows-International-Core-WinPE',locale+'<SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>')+component('Microsoft-Windows-Setup',setup)+'</settings><settings pass="specialize">'+component('Microsoft-Windows-Shell-Setup','<ComputerName>*</ComputerName>')+'</settings><settings pass="oobeSystem">'+component('Microsoft-Windows-International-Core',locale)+component('Microsoft-Windows-Shell-Setup',shell)+'</settings></unattend>').replace('en-US',language)

def render(request,folder,iso_hash,base,callback):
    backend=request['backend'];guest=request['guest_os'];plugin=POLICY['plugins'][backend]
    http=folder/'http';http.mkdir()
    source={'iso_url':Path(request['iso_path']).as_uri(),'iso_checksum':'sha256:'+iso_hash,
            'communicator':'none','headless':True,'boot_wait':'10s','shutdown_timeout':'2h',
            'memory':request['memory_mb'],'cpus':request['cpus'],'disk_size':request['disk_mb'],
            'output_directory':str(folder/'artifact')}
    if guest=='debian':
        text=(ROOT/'guest_setup/http/debian-preseed.cfg').read_text()
        text=ensure_openssh_preseed(text)
        text+='\nd-i preseed/late_command string wget -qO /tmp/vamp-postdeb.sh '+base+'/postdeb.sh && VAMP_SCRIPT_BASE_URL='+base+' VAMP_PACKER_CALLBACK='+callback+' sh /tmp/vamp-postdeb.sh\n'
        if backend=='kvm':text+='d-i grub-installer/force-efi-extra-removable boolean true\n'
        (http/'preseed.cfg').write_text(text)
        source.update(http_directory=str(http),boot_command=['c<wait>','linux /install.amd/vmlinuz auto=true priority=critical preseed/url=http://{{ .HTTPIP }}:{{ .HTTPPort }}/preseed.cfg vamp_base='+base+' --- quiet<enter>','initrd /install.amd/initrd.gz<enter>','boot<enter>'])
    else:
        answer=folder/'Autounattend.xml';answer.write_text(windows_answer(base,callback,request.get('image_index',1),'ko-KR' if 'ko-kr' in request['iso_path'].lower() else 'en-US',request.get('product_key','')),encoding='utf8')
        script=folder/'vamp-postinstall.ps1';script.write_text(windows_postinstall(base,callback,backend),encoding='utf8')
        media=folder/'answer.iso';answer_iso(answer,media,script,request.get('driver_iso'))
        # Windows media accepts a key only briefly. Send a short burst on the
        # initial Packer boot; Packer never replays boot_command after reboots.
        source.update(boot_wait='1s',boot_command=['<enter><wait1>']*10)
    if backend=='virtualbox':
        source.update(vm_name='VAMP-build-'+folder.name[:12],guest_os_type='Windows11_64' if guest=='windows11' else 'Debian_64',
                      firmware='efi',hard_drive_interface='sata',iso_interface='sata',sata_port_count=3,format='ova',guest_additions_mode='disable',virtualbox_version_file='',disable_shutdown=True,
                      vboxmanage=[['modifyvm','{{.Name}}','--mouse','usbtablet','--vram','128','--nat-localhostreachable1','on','--graphicscontroller','vboxsvga' if guest=='windows11' else 'vmsvga']]+([['modifyvm','{{.Name}}','--tpm-type','2.0']] if guest=='windows11' else []))
        if guest=='windows11':source['vboxmanage'].append(['storageattach','{{.Name}}','--storagectl','SATA','--port','2','--device','0','--type','dvddrive','--medium',str(media)])
    elif backend=='hyperv':
        source.update(vm_name='VAMP-build-'+folder.name[:12],generation=2,switch_name=request.get('switch_name','Default Switch'),
                      enable_secure_boot=guest=='windows11',enable_tpm=guest=='windows11',disable_shutdown=True,
                      temp_path=str(folder/'temporary'),skip_compaction=True)
        if guest=='windows11':source['secondary_iso_images']=[str(media)]
    else:
        profile=request.get('osinfo',{})
        source.update(vm_name='golden.qcow2',format='qcow2',accelerator='kvm',cpu_model='host',disk_interface='sata' if guest=='windows11' else 'virtio',
                      net_device='e1000',efi_boot=True)
        if profile:
            source.update(machine_type=profile['machine'],disk_interface=profile['disk_bus'],
                          net_device='virtio-net' if profile['nic']=='virtio' else profile['nic'],
                          vga={'vga':'std','bochs':'bochs-display'}.get(profile['video'],profile['video']),
                          efi_firmware_code=profile['firmware_code'],efi_firmware_vars=profile['firmware_vars'])
        if guest=='windows11':source.update(vtpm=True,tpm_device_type='tpm-crb',qemuargs=[['-drive','file='+str(media)+',media=cdrom,index=3,readonly=on']])
    def value(item):
        return json.dumps(item,ensure_ascii=True).replace('${','$${').replace('%{','%%{')
    header='packer {\n required_version = ">= 1.16.2"\n required_plugins {\n '+backend+' = {\n source = '+value(plugin['source'])+'\n version = '+value('= '+plugin['version'])+'\n }\n }\n}\n'
    hcl=header+'source '+value(plugin['builder'])+' "vamp" {\n'+''.join(' '+key+' = '+value(val)+'\n' for key,val in source.items())+'}\nbuild {\n sources = ["source.'+plugin['builder']+'.vamp"]\n}\n'
    template=folder/'guest.pkr.hcl';template.write_text(hcl,encoding='utf8');return template
