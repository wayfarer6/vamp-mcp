"""Deterministic VirtualBox unattended provisioning; no AI loop required."""
from __future__ import annotations
import argparse
import base64
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
sys.path.insert(0,str(ROOT/'backends/common'))
from guest_install import PROFILE, require_install_host, efi_boot_plan, virtualbox_preseed, post_create_notice
sys.path.insert(0,str(Path(__file__).resolve().parent))
from script_server import SCRIPT_SERVER_PORT, guest_commands, start as start_script_server

PUBLIC_CREDENTIALS={'username':'vboxuser','password':'password123!','public_sandbox_credentials':True}


def parse(text):
    return {m[1].strip():m[2].strip() for line in text.splitlines()
            if (m:=re.match(r'([^=]+)=\"?(.*?)\"?$',line.strip()))}


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


def post_install_command(guest_os, base_url):
    """Post-install hook fetched from the host script server; no ISO is rewritten or mounted."""
    if guest_os=='windows11':
        command=("$ErrorActionPreference='Stop'; $p=Join-Path $env:TEMP 'vamp-postwin.ps1'; "
                 "for($i=0;$i -lt 30;$i++){try{"
                 f"Invoke-WebRequest -UseBasicParsing -Uri '{base_url}/postwin.ps1' -OutFile $p -TimeoutSec 20; break"
                 "}catch{if($i -eq 29){throw}; Start-Sleep -Seconds 3}}; & $p")
        # VBox's VBOXPOST.CMD also echoes this command inside double quotes.
        # A nested -Command string exposes its pipe/operators to cmd.exe there.
        encoded=base64.b64encode(command.encode('utf-16-le')).decode('ascii')
        return f'powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}'
    return f'wget -qO /tmp/vamp-postdeb.sh {base_url}/postdeb.sh && sh /tmp/vamp-postdeb.sh'


def create(iso_path,name=None,memory_mb=None,cpus=None,disk_mb=None,basedir=None,image_index=1,product_key='',windows_confirmed=False,guest_os=None,preflight_only=False,allow_manual_install=False,installation_mode="auto",serve_scripts=True,script_server_ttl=7200):
    require_install_host('virtualbox')
    if installation_mode not in ('auto','manual'):raise ValueError('installation_mode must be auto or manual')
    name=name or ('VAMP-'+uuid.uuid4().hex[:8])
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',name):raise ValueError('Use 1-64 letters/digits/underscore/hyphen for name')
    iso=Path(iso_path).expanduser().resolve(strict=True)
    if not iso.is_file():raise ValueError('ISO path must be a readable local file on the VM host')
    journal={'status':'preparing','vm':name,'credentials':PUBLIC_CREDENTIALS,'events':[],
             'installation_verified':False,'recorder_installed_verified':False,
             'development_only':os.environ.get('VAMP_DEVELOPMENT_VM')=='1',
             'guest_setup_transport':f'http://10.0.2.2:{SCRIPT_SERVER_PORT} (host Python script server)'}
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
        if guest_os not in manual_types or not (allow_manual_install or (guest_os=='debian' and installation_mode=='auto')):raise
        detected={'OSTypeId':manual_types[guest_os],'IsInstallSupported':'false'}
    os_type=detected.get('OSTypeId',detected.get('detectedOSTypeId',''))
    if not (re.fullmatch(r'Debian[0-9]*_64',os_type) or re.fullmatch(r'Ubuntu[0-9]*_64',os_type) or os_type=='Windows11_64'):
        raise ValueError(f'Only detected Debian/Ubuntu amd64 or Windows11 x64 ISO supported by this initial profile: {os_type or "unknown"}')
    unattended_supported=detected.get('IsInstallSupported',detected.get('isInstallSupported','true')).lower() in ('true','1','yes','on')
    if installation_mode=='manual':unattended_supported=False
    direct_debian_boot=(installation_mode=='auto' and guest_os=='debian' and not unattended_supported)
    if not unattended_supported and not allow_manual_install and not direct_debian_boot:
        raise ValueError('VirtualBox reports this ISO does not support unattended installation')
    selected='windows11' if os_type=='Windows11_64' else ('ubuntu' if os_type.startswith('Ubuntu') else 'debian')
    if guest_os and guest_os!=selected:raise ValueError('Selected guest OS does not match detected ISO')
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
                'installation_mode':'unattended' if unattended_supported or direct_debian_boot else 'manual',
                'guest_setup':{'transport':'http','port':SCRIPT_SERVER_PORT,'commands':guest_commands(SCRIPT_SERVER_PORT)},
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
                # Stock Windows install media waits for a key before booting.
                # Send once on the initial provisioning boot, never on later reboots.
                if selected=='windows11':
                    time.sleep(PROFILE['boot_wait_seconds'])
                    run('controlvm',name,'keyboardputscancode','1c','9c')
                    journal['events'].append('installer-boot-enter-sent')
                return
            if state not in ('starting','restoring'):break
            time.sleep(1)
        raise RuntimeError(f'VM creation completed but startup was not verified (state: {state}); inspect the VM log')
    def record(stage):
        journal['events'].append(stage)
        journal_path.write_text(json.dumps(journal,indent=2)+'\n')
    script_server=None
    if serve_scripts and not os.environ.get('VAMP_SCRIPT_SERVER_DISABLE'):
        try:
            script_server=start_script_server(port=SCRIPT_SERVER_PORT,ttl=script_server_ttl)
        except Exception as exc:
            script_server={'status':'failed','port':SCRIPT_SERVER_PORT,'error':str(exc)}
        journal['script_server']=script_server
        if script_server.get('status')!='running':
            journal.update(status='failed',error='Guest setup HTTP server could not start: '+str(script_server.get('error',script_server.get('status'))))
            record('script-server-failed')
            raise RuntimeError(journal['error'])
    base_url=(script_server or {}).get('guest_urls',{}).get('virtualbox_nat') or f'http://10.0.2.2:{SCRIPT_SERVER_PORT}'
    journal['post_create_notice']=post_create_notice(selected,base_url)
    try:
        run('createvm','--name',name,'--ostype',os_type,'--register','--basefolder',folder.parent)
        record('vm-created')
        from display import preferences
        journal['display']=preferences(name,run)
        from shares import prepare
        journal['recording_share']=prepare(name,run)
        options=['modifyvm',name,'--memory',memory_mb,'--cpus',cpus,'--vram',128,
                 '--mouse','usbtablet','--nic1','nat','--nat-localhostreachable1','on','--boot1','dvd','--boot2','disk',
                 '--graphicscontroller','vboxsvga' if os_type=='Windows11_64' else 'vmsvga']
        if os_type=='Windows11_64':options+=['--firmware','efi','--tpm-type','2.0','--ioapic','on']
        if direct_debian_boot:options+=['--firmware','efi']
        run(*options)
        disk=folder/(name+'.vdi')
        run('createmedium','disk','--filename',disk,'--size',disk_mb,'--format','VDI')
        run('storagectl',name,'--name','SATA','--add','sata','--controller','IntelAhci','--portcount','4')
        run('storageattach',name,'--storagectl','SATA','--port','0','--device','0','--type','hdd','--medium',disk)
        run('storagectl',name,'--name','IDE','--add','ide')
        if not unattended_supported:
            run('storageattach',name,'--storagectl','SATA','--port','1','--device','0','--type','dvddrive','--medium',iso)
            start_verified()
            if direct_debian_boot:
                # Debian 13 DVD detection is unimplemented in some VBox builds.
                # Boot the stock EFI GRUB console with the HTTP preseed instead.
                time.sleep(PROFILE['boot_wait_seconds'])
                for step in efi_boot_plan('debian',base_url):
                    if step['kind']=='wait':time.sleep(step['seconds'])
                    elif step['kind'] in ('text','line'):
                        run('controlvm',name,'keyboardputstring',step['text'])
                    if step['kind'] in ('line','enter'):
                        run('controlvm',name,'keyboardputscancode','1c','9c')
                journal.update(status='installation_started',installation_mode='unattended',boot_method='efi-http-preseed',os_type=os_type,credentials=PUBLIC_CREDENTIALS,journal=str(journal_path))
                record('debian-http-preseed-boot-dispatched')
                return journal
            journal.update(status='installation_started',installation_mode='manual',os_type=os_type,
                           frontend='headless',journal=str(journal_path),
                           credentials={'public_sandbox_credentials':False,'account_setup':'Choose your account in the OS installer'},
                           action_required=(f'This ISO needs a manual installation: complete the stock installer in the VM screen, '
                                            f'choose your own guest account, then run the guest setup command from '
                                            f'http://10.0.2.2:{SCRIPT_SERVER_PORT}/ (for example '
                                            f'"wget -qO- {base_url}/setup.sh | sh"). No ISO was rewritten and no automatic account or recorder setup ran.'))
            record('manual-installation-started')
            return journal
        if os_type=='Windows11_64':
            from display import insert_additions
            journal['guest_additions']=insert_additions(name,run=run)
        install_args=['unattended','install',name,'--iso',iso,'--user','vboxuser',password_flag,'password123!',
              '--full-user-name','VAMP Sandbox User','--hostname',name.lower()+'.vamp.local',
              '--no-install-additions','--post-install-command',post_install_command(selected,base_url)]
        if selected=='debian':
            template=folder/'debian-preseed.cfg'
            template.write_text(virtualbox_preseed(),encoding='utf-8')
            install_args+=['--script-template',str(template)]
        if os_type=='Windows11_64':
            install_args+=['--image-index',image_index]
            if product_key:install_args+=['--key',product_key]
        run(*install_args,timeout=300)
        start_verified()
        journal.update(status='installation_started',installation_mode='unattended',os_type=os_type,frontend='headless',
                       recorder_setup=f'First login downloads the setup bundle from the host script server on port {SCRIPT_SERVER_PORT}',
                       guest_setup_command=f'wget -qO- {base_url}/setup.sh | sh' if selected!='windows11' else f'irm {base_url}/setup.ps1 | iex',
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
    sys.path.insert(0,str(ROOT/'backends/packer'))
    from runner import create as packer_create
    try: print(json.dumps(packer_create({'backend':'virtualbox',**json.load(sys.stdin)})))
    except Exception as exc:
        print(json.dumps({'status':'failed','error':str(exc)}));sys.exit(1)
