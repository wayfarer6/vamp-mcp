"""Native guest 1920x1080 plus a scaled observation frontend."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
try:
    from .provision import executable, parse
except ImportError:
    from provision import executable, parse

WIDTH,HEIGHT=1920,1080
DISPLAY_DATA={'GUI/Fullscreen':'','GUI/Seamless':'','GUI/Scale':'true',
              'GUI/AutoresizeGuest':'false','GUI/LastGuestSizeHint':'1920,1080',
              'CustomVideoMode1':'1920x1080x32'}

def command(*args):
    result=subprocess.run([executable(),*map(str,args)],capture_output=True,encoding='utf-8',timeout=60)
    if result.returncode:raise RuntimeError(result.stderr.strip()[:500] or 'VBoxManage failed')
    return result.stdout

def preferences(vm,run=command):
    # Permit full HD even when the host viewer's available area is smaller.
    run('setextradata','global','GUI/MaxGuestResolution','any')
    for key,value in DISPLAY_DATA.items():run('setextradata',vm,key,value)
    return {'native_target':[WIDTH,HEIGHT],'viewer':'scaled','auto_resize_guest':False,
            'resolution_verified':False,'viewer_reopen_may_be_required':True}

def configure(vm,run=command):
    info=parse(run('showvminfo',vm,'--machinereadable'))
    result=preferences(vm,run)
    result.update(status='configured',vm=vm)
    if info.get('VMState')=='running':
        try:
            run('controlvm',vm,'setvideomodehint',WIDTH,HEIGHT,32)
            result['video_hint']='sent'
        except RuntimeError as exc:result.update(video_hint='failed',action_required=str(exc))
        try:
            with tempfile.TemporaryDirectory() as directory:
                shot=Path(directory)/'screen.png'
                run('controlvm',vm,'screenshotpng',shot)
                header=shot.read_bytes()[:24]
                if header[:8]!=b'\x89PNG\r\n\x1a\n':raise ValueError('Screenshot is not PNG')
                size=struct.unpack('>II',header[16:24]);result['observed_resolution']=list(size)
                result['resolution_verified']=size==(WIDTH,HEIGHT)
        except (OSError,ValueError,RuntimeError,struct.error) as exc:
            result['verification_error']=str(exc)
    if not result['resolution_verified']:
        result['action_required']='Set 1920x1080 inside the guest OS after installing display drivers/Guest Additions; recheck with vm_configure_display.'
    return result

def find_additions(run=command,iso_path=None):
    if iso_path:
        path=Path(iso_path).expanduser().resolve(strict=True)
        if not path.is_file():raise ValueError('Guest Additions ISO must be a local file')
        return path
    text=run('list','systemproperties')
    for line in text.splitlines():
        if 'Default Additions ISO' in line:
            candidate=Path(line.split(':',1)[1].strip())
            if candidate.is_file():return candidate
    candidates=[Path(executable()).resolve().parent/'VBoxGuestAdditions.iso',
      Path(os.environ.get('PROGRAMFILES','C:/Program Files'))/'Oracle/VirtualBox/VBoxGuestAdditions.iso',
      Path('/usr/share/virtualbox/VBoxGuestAdditions.iso'),
      Path('/Applications/VirtualBox.app/Contents/MacOS/VBoxGuestAdditions.iso')]
    return next((p for p in candidates if p.is_file()),None)

def insert_additions(vm,iso_path=None,run=command):
    info=parse(run('showvminfo',vm,'--machinereadable'))
    if not info.get('ostype','').startswith('Windows'):
        raise ValueError('This handoff is for a Windows VM; inspect the VM OS type first')
    iso=find_additions(run,iso_path)
    if iso is None:
        return {'status':'iso_not_found','vm':vm,'guest_additions_installed_verified':False,
                'action_required':'Install/download the Guest Additions ISO matching your host VirtualBox version, then pass iso_path.'}
    if not any(k.startswith('storagecontrollername') and v=='SATA' for k,v in info.items()):
        raise ValueError('Expected VAMP SATA controller. Select an empty optical drive manually for other VM layouts.')
    # Port 2 is reserved for GA in VAMP-created VMs; never replace another disk/ISO.
    occupied=info.get('SATA-2-0','')
    if occupied and occupied not in ('none','emptydrive'):
        if os.path.normcase(os.path.abspath(occupied))!=os.path.normcase(str(iso.resolve())):
            raise ValueError('Reserved SATA port 2 is occupied; refusing to replace media')
    else:
        run('storageattach',vm,'--storagectl','SATA','--port',2,'--device',0,
            '--type','dvddrive','--medium',iso)
    return {'status':'media_inserted','vm':vm,'iso':str(iso),'guest_additions_installed_verified':False,
            'action_required':'In Windows open the VirtualBox Guest Additions CD, run VBoxWindowsAdditions.exe, approve UAC and reboot. Then select Display resolution 1920x1080, Scale 100%, and call vm_configure_display.'}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['configure','additions'])
    args=parser.parse_args()
    try:
        values=json.load(sys.stdin)
        print(json.dumps((configure if args.action=='configure' else insert_additions)(**values)))
    except Exception as exc:
        print(json.dumps({'status':'failed','error':str(exc)}));sys.exit(1)
