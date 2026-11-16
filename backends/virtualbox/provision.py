"""Deterministic VirtualBox unattended provisioning; no AI loop required."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from build_recorder_media import build
from build_debian_installer import build as build_debian_installer

PUBLIC_CREDENTIALS={'username':'vboxuser','password':'password123!','public_sandbox_credentials':True}

def parse(text):
    return {m[1].strip():m[2].strip() for line in text.splitlines()
            if (m:=re.match(r'([^=]+)="?(.*?)"?$',line.strip()))}

def executable():
    if os.environ.get('VBOXMANAGE_PATH'): return os.environ['VBOXMANAGE_PATH']
    if sys.platform=='win32':
        candidate=Path(os.environ.get('PROGRAMFILES','C:/Program Files'))/'Oracle/VirtualBox/VBoxManage.exe'
        if candidate.is_file():return str(candidate)
    return shutil.which('VBoxManage') or 'VBoxManage'

def assert_no_active_kvm():
    if not sys.platform.startswith('linux'):return
    for uri in ('qemu:///session','qemu:///system'):
        try:
            result=subprocess.run(['virsh','-c',uri,'list','--name'],capture_output=True,text=True,timeout=10)
        except (FileNotFoundError,subprocess.TimeoutExpired):continue
        if result.returncode==0 and result.stdout.strip():
            raise RuntimeError('A KVM VM is active. Shut it down before starting VirtualBox; simultaneous execution can cause VERR_SVM_IN_USE.')

def create(iso_path,name=None,memory_mb=None,cpus=None,disk_mb=None,basedir=None,image_index=1,product_key='',windows_confirmed=False,guest_os=None,preflight_only=False,allow_manual_install=False,installation_mode="auto"):
    if installation_mode not in ('auto','manual'):raise ValueError('installation_mode must be auto or manual')
    name=name or ('VAMP-'+uuid.uuid4().hex[:8])
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',name):raise ValueError('Use 1-64 letters/digits/underscore/hyphen for name')
    iso=Path(iso_path).expanduser().resolve(strict=True)
    if not iso.is_file():raise ValueError('ISO path must be a readable local file on the VM host')
    journal={'status':'preparing','vm':name,'credentials':PUBLIC_CREDENTIALS,'events':[],
             'installation_verified':False,'recorder_installed_verified':False}
    folder=Path(basedir or Path.home()/'VirtualBox VMs').expanduser().resolve()/name
    def run(*args,timeout=120):
        proc=subprocess.run([executable(),*map(str,args)],capture_output=True,text=True,timeout=timeout)
        if proc.returncode:raise RuntimeError(f'VBoxManage {args[0]} failed: {proc.stderr.strip()[:500]}')
        return proc.stdout
    listed=run('list','vms')
    if any(line.startswith('"'+name+'" ') for line in listed.splitlines()):raise ValueError('VM name already exists; refusing to modify it')
    try:
        detected=parse(run('unattended','detect','--iso',iso,'--machine-readable'))
    except RuntimeError:
        manual_types={'debian':'Debian_64','ubuntu':'Ubuntu_64','windows11':'Windows11_64'}
        if not allow_manual_install or guest_os not in manual_types:raise
        detected={'OSTypeId':manual_types[guest_os],'IsInstallSupported':'false'}
    os_type=detected.get('OSTypeId',detected.get('detectedOSTypeId',''))
    if not (re.fullmatch(r'Debian[0-9]*_64',os_type) or re.fullmatch(r'Ubuntu[0-9]*_64',os_type) or os_type=='Windows11_64'):
        raise ValueError(f'Only detected Debian/Ubuntu amd64 or Windows11 x64 ISO supported by this initial profile: {os_type or "unknown"}')
    unattended_supported=detected.get('IsInstallSupported',detected.get('isInstallSupported','true')).lower() in ('true','1','yes','on')
    if installation_mode=='manual':unattended_supported=False
    if not unattended_supported and not allow_manual_install:
        raise ValueError('VirtualBox reports this ISO does not support unattended installation')
    selected='windows11' if os_type=='Windows11_64' else ('ubuntu' if os_type.startswith('Ubuntu') else 'debian')
    if guest_os and guest_os!=selected:raise ValueError('Selected guest OS does not match detected ISO')
    custom_debian=not unattended_supported and selected=='debian' and installation_mode!='manual'
    profile=json.loads(Path(__file__).with_name('profiles.json').read_text())['profiles'][selected]
    memory_mb=memory_mb if memory_mb is not None else profile['memory_mb']
    cpus=cpus if cpus is not None else profile['cpus']
    disk_mb=disk_mb if disk_mb is not None else profile['disk_mb']
    if not (2048<=memory_mb<=131072 and 1<=cpus<=64 and 32768<=disk_mb<=2097152 and image_index>=1):
        raise ValueError('Invalid VM resource/image limits')
    if preflight_only:
        return {'status':'preflight_ready','vm_created':False,'guest_os':selected,
                'resource_profile':{'memory_mb':memory_mb,'cpus':cpus,'disk_mb':disk_mb},
                'windows_confirmation_required':selected=='windows11' and not windows_confirmed,
                'installation_mode':'unattended' if unattended_supported or custom_debian else 'manual',
                'credentials':PUBLIC_CREDENTIALS,'iso':str(iso)}
    if selected=='windows11' and not windows_confirmed:
        return {'status':'needs_windows_confirmation','no_vm_created':True,'profile':profile,
          'action_required':'Ask the user whether to create Windows with these specs. Windows requires a valid license; activate it yourself after installation in Settings > System > Activation. VAMP does not include a Windows license.',
          'credentials':PUBLIC_CREDENTIALS}
    journal['resource_profile']={'guest_os':selected,'memory_mb':memory_mb,'cpus':cpus,'disk_mb':disk_mb,
                                'native_resolution':[1920,1080]}
    if selected=='windows11':journal['license_notice']='Windows requires a valid license. Activate Windows yourself after installation; VAMP supplies no license or activation bypass.'
    if os_type=='Windows11_64' and memory_mb<4096:raise ValueError('Windows 11 requires at least 4096 MB')
    # Check version-specific password option before creating any VM.
    help_text=''
    if unattended_supported:
        help_proc=subprocess.run([executable(),'unattended','install','--help'],capture_output=True,text=True)
        help_text=help_proc.stdout+help_proc.stderr
    password_flag='--user-password' if '--user-password' in help_text else '--password'
    assert_no_active_kvm()
    folder.mkdir(parents=True,exist_ok=False)
    journal_path=folder/'vamp-install.json'
    def start_verified():
        # startvm waits for its session to open; still verify the hypervisor state.
        run('startvm',name,'--type','headless')
        state=''
        for attempt in range(15):
            state=parse(run('showvminfo',name,'--machinereadable')).get('VMState','unknown')
            if state=='running':
                journal.update(vm_state=state,startup_verified=True)
                return
            if state not in ('starting','restoring'):break
            time.sleep(1)
        raise RuntimeError(f'VM creation completed but startup was not verified (state: {state}); inspect the VM log')
    def record(stage):
        journal['events'].append(stage)
        journal_path.write_text(json.dumps(journal,indent=2)+'\n')
    try:
        media=build(folder/'recorder-setup.iso')
        record('recorder-media-built')
        if custom_debian:
            iso=Path(build_debian_installer(iso,folder/'debian-installer.iso')['iso'])
            record('debian-installer-prepared')
        run('createvm','--name',name,'--ostype',os_type,'--register','--basefolder',folder.parent)
        record('vm-created')
        from display import preferences
        journal['display']=preferences(name,run)
        from shares import prepare
        journal['recording_share']=prepare(name,run)
        options=['modifyvm',name,'--memory',memory_mb,'--cpus',cpus,'--vram',128,
                 '--mouse','usbtablet','--nic1','nat','--boot1','disk' if custom_debian else 'dvd','--boot2','dvd' if custom_debian else 'disk',
                 '--graphicscontroller','vboxsvga' if os_type=='Windows11_64' else 'vmsvga']
        if custom_debian:
            journal['serial_log']=str(folder/'serial.log')
            options+=['--uart1','0x3F8',4,'--uartmode1','file',folder/'serial.log']
        if os_type=='Windows11_64':options+=['--firmware','efi','--tpm-type','2.0','--ioapic','on']
        run(*options)
        disk=folder/(name+'.vdi')
        run('createmedium','disk','--filename',disk,'--size',disk_mb,'--format','VDI')
        run('storagectl',name,'--name','SATA','--add','sata','--controller','IntelAhci','--portcount','4')
        run('storageattach',name,'--storagectl','SATA','--port','0','--device','0','--type','hdd','--medium',disk)
        run('storagectl',name,'--name','IDE','--add','ide')
        if not unattended_supported:
            run('storageattach',name,'--storagectl','SATA','--port','1','--device','0','--type','dvddrive','--medium',iso)
            start_verified()
            journal.update(status='installation_started',installation_mode='unattended' if custom_debian else 'manual',os_type=os_type,
                           frontend='headless',journal=str(journal_path),
                           credentials=PUBLIC_CREDENTIALS if custom_debian else {'public_sandbox_credentials':False,'account_setup':'Choose your account in the OS installer'},
                           action_required='Debian unattended installation started with a single installation DVD. Recorder media was built but is not attached; install it after the OS is ready.' if custom_debian else 'This ISO needs manual installation. Follow the installer in the VM screen. Choose your own guest account; automatic recorder setup has not run.')
            if custom_debian:journal.update(recorder_media=media['iso'],recorder_media_attached=False)
            record('unattended-installation-started' if custom_debian else 'manual-installation-started')
            return journal
        # Recorder media stays on a dedicated DVD; unattended owns its own installer/auxiliary slots.
        run('storageattach',name,'--storagectl','SATA','--port','3','--device','0','--type','dvddrive','--medium',media['iso'])
        if os_type=='Windows11_64':
            from display import insert_additions
            journal['guest_additions']=insert_additions(name,run=run)
            hook='cmd.exe /c "for %%D in (D E F G H I J K L M N O P) do @if exist %%D:\\postwin.cmd call %%D:\\postwin.cmd"'
        else:
            hook="sh -c 'mkdir -p /tmp/vamp-recorder; for d in /dev/sr*; do mount -o ro \"$d\" /tmp/vamp-recorder 2>/dev/null || continue; if [ -f /tmp/vamp-recorder/postdeb.sh ]; then sh /tmp/vamp-recorder/postdeb.sh; exit $?; fi; umount /tmp/vamp-recorder; done; exit 1'"
        args=['unattended','install',name,'--iso',iso,'--user','vboxuser',password_flag,'password123!',
              '--full-user-name','VAMP Sandbox User','--hostname',name.lower()+'.vamp.local',
              '--no-install-additions','--post-install-command',hook]
        if os_type=='Windows11_64':
            args+=['--image-index',image_index]
            if product_key:args+=['--key',product_key]
        run(*args,timeout=300)
        start_verified()
        journal.update(status='installation_started',installation_mode='unattended',os_type=os_type,frontend='headless',
                       recorder_setup='Debian postinstall; Windows first desktop login',
                       requires_ai_loop=False,journal=str(journal_path))
        record('unattended-installation-started')
        return journal
    except Exception as exc:
        journal.update(status='failed',error=str(exc),partial_vm_preserved=True)
        record('failed')
        raise RuntimeError(f'{exc}; partial setup preserved at {folder}') from exc

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json-stdin',action='store_true',required=True)
    parser.parse_args()
    try: print(json.dumps(create(**json.load(sys.stdin))))
    except Exception as exc:
        print(json.dumps({'status':'failed','error':str(exc)}));sys.exit(1)
