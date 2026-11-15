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
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from build_recorder_media import build

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

def create(iso_path,name=None,memory_mb=4096,cpus=2,disk_mb=65536,basedir=None,image_index=1,product_key=''):
    name=name or ('VAMP-'+uuid.uuid4().hex[:8])
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',name):raise ValueError('Use 1-64 letters/digits/underscore/hyphen for name')
    if not (2048<=memory_mb<=131072 and 1<=cpus<=64 and 32768<=disk_mb<=2097152 and image_index>=1):
        raise ValueError('Invalid VM resource/image limits')
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
    detected=parse(run('unattended','detect','--iso',iso,'--machine-readable'))
    os_type=detected.get('detectedOSTypeId','')
    if not (re.fullmatch(r'Debian[0-9]*_64',os_type) or os_type=='Windows11_64'):
        raise ValueError(f'Only detected Debian_64 / Windows11_64 ISO supported by this initial profile: {os_type or "unknown"}')
    if detected.get('isInstallSupported','true').lower() not in ('true','1','yes'):
        raise ValueError('VirtualBox reports this ISO does not support unattended installation')
    if os_type=='Windows11_64' and memory_mb<4096:raise ValueError('Windows 11 requires at least 4096 MB')
    # Check version-specific password option before creating any VM.
    help_proc=subprocess.run([executable(),'unattended','install','--help'],capture_output=True,text=True)
    help_text=help_proc.stdout+help_proc.stderr
    password_flag='--user-password' if '--user-password' in help_text else '--password'
    folder.mkdir(parents=True,exist_ok=False)
    journal_path=folder/'vamp-install.json'
    def record(stage):
        journal['events'].append(stage)
        journal_path.write_text(json.dumps(journal,indent=2)+'\n')
    try:
        media=build(folder/'recorder-setup.iso')
        record('recorder-media-built')
        run('createvm','--name',name,'--ostype',os_type,'--register','--basefolder',folder.parent)
        record('vm-created')
        options=['modifyvm',name,'--memory',memory_mb,'--cpus',cpus,'--vram',128,
                 '--mouse','usbtablet','--nic1','nat','--boot1','dvd','--boot2','disk',
                 '--graphicscontroller','vboxsvga' if os_type=='Windows11_64' else 'vmsvga']
        if os_type=='Windows11_64':options+=['--firmware','efi','--tpm-type','2.0','--ioapic','on']
        run(*options)
        disk=folder/(name+'.vdi')
        run('createmedium','disk','--filename',disk,'--size',disk_mb,'--format','VDI')
        run('storagectl',name,'--name','SATA','--add','sata','--controller','IntelAhci','--portcount','4')
        run('storageattach',name,'--storagectl','SATA','--port','0','--device','0','--type','hdd','--medium',disk)
        run('storagectl',name,'--name','IDE','--add','ide')
        # Recorder media stays on a dedicated DVD; unattended owns its own installer/auxiliary slots.
        run('storageattach',name,'--storagectl','SATA','--port','3','--device','0','--type','dvddrive','--medium',media['iso'])
        if os_type=='Windows11_64':
            hook='cmd.exe /c "for %%D in (D E F G H I J K L M N O P) do @if exist %%D:\\postwin.cmd call %%D:\\postwin.cmd"'
        else:
            hook="sh -c 'mkdir -p /tmp/vamp-recorder; for d in /dev/sr*; do mount -o ro \"$d\" /tmp/vamp-recorder 2>/dev/null || continue; if [ -f /tmp/vamp-recorder/postdeb.sh ]; then sh /tmp/vamp-recorder/postdeb.sh; exit $?; fi; umount /tmp/vamp-recorder; done; exit 1'"
        args=['unattended','install',name,'--iso',iso,'--user','vboxuser',password_flag,'password123!',
              '--full-user-name','VAMP Sandbox User','--hostname',name.lower()+'.vamp.local',
              '--no-install-additions','--post-install-command',hook,'--start-vm','separate']
        if os_type=='Windows11_64':
            args+=['--image-index',image_index]
            if product_key:args+=['--key',product_key]
        run(*args,timeout=300)
        journal.update(status='installation_started',os_type=os_type,frontend='separate',
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
