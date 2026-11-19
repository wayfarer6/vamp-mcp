#!/usr/bin/env python3
"""Root-only persistent Debian VM display and awake desktop configuration."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET

HERE=Path(__file__).resolve().parent

def write(path,text):
    path=Path(path)
    if path.exists() and path.read_text()==text:return False
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(text)
    return True

def connectors():
    outputs=[]
    for status in sorted(Path('/sys/class/drm').glob('card*-*/status')):
        match=re.fullmatch(r'card\d+-(.+)',status.parent.name)
        if match and status.read_text().strip()=='connected':outputs.append(match[1])
    return outputs

def prepare():
    ports=connectors()
    video=' '.join('video='+port+':1920x1080@60D' for port in ports) if ports else 'video=1920x1080@60D'
    grub="""# Managed VAMP guest display: replace video overrides, preserve other arguments.
vamp_video_args=
for vamp_arg in $GRUB_CMDLINE_LINUX_DEFAULT; do
 case "$vamp_arg" in video=*) ;; *) vamp_video_args="$vamp_video_args $vamp_arg" ;; esac
done
GRUB_CMDLINE_LINUX_DEFAULT="$vamp_video_args __VIDEO__"
GRUB_GFXMODE=1920x1080x32
GRUB_GFXPAYLOAD_LINUX=keep
unset vamp_video_args vamp_arg
""".replace('__VIDEO__',video)
    changed=write('/etc/default/grub.d/99-vamp-display.cfg',grub)
    if changed:subprocess.run(['update-grub'],check=True)
    defaults="""[org/gnome/desktop/session]
idle-delay=uint32 0
[org/gnome/desktop/screensaver]
lock-enabled=false
idle-activation-enabled=false
[org/gnome/settings-daemon/plugins/power]
idle-dim=false
sleep-inactive-ac-type='nothing'
sleep-inactive-battery-type='nothing'
sleep-inactive-ac-timeout=0
sleep-inactive-battery-timeout=0
"""
    write('/etc/dconf/db/vamp.d/00-automation',defaults)
    keys=['/org/gnome/desktop/session/idle-delay','/org/gnome/desktop/screensaver/lock-enabled','/org/gnome/desktop/screensaver/idle-activation-enabled']
    keys+=['/org/gnome/settings-daemon/plugins/power/'+key for key in ['idle-dim','sleep-inactive-ac-type','sleep-inactive-battery-type','sleep-inactive-ac-timeout','sleep-inactive-battery-timeout']]
    write('/etc/dconf/db/vamp.d/locks/automation','\n'.join(keys)+'\n')
    for name in ['user','gdm']:
        profile=Path('/etc/dconf/profile')/name
        text=profile.read_text() if profile.exists() else 'user-db:user\n'
        if 'system-db:vamp' not in text.splitlines():write(profile,str(text).rstrip()+'\nsystem-db:vamp\n')
    subprocess.run(['dconf','update'],check=True)
    write('/etc/systemd/logind.conf.d/90-vamp-awake.conf','[Login]\nIdleAction=ignore\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\nHandleSuspendKey=ignore\nHandleHibernateKey=ignore\n')
    write('/etc/X11/xorg.conf.d/20-vamp-no-dpms.conf','Section "ServerFlags"\n Option "BlankTime" "0"\n Option "StandbyTime" "0"\n Option "SuspendTime" "0"\n Option "OffTime" "0"\nEndSection\n')
    subprocess.run(['systemctl','mask','sleep.target','suspend.target','hibernate.target','hybrid-sleep.target'],check=True)
    import importlib.util
    spec=importlib.util.spec_from_file_location('vamp_gdm',HERE/'configure-gdm.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.configure('/etc/gdm3/daemon.conf')
    boot_unit='[Unit]\nDescription=VAMP persistent Full HD boot display\nAfter=systemd-udev-settle.service\nWants=systemd-udev-settle.service\nBefore=display-manager.service\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 '+str(HERE/'configure-debian-display.py')+' prepare\n[Install]\nWantedBy=graphical.target\n'
    sync_unit='[Unit]\nDescription=VAMP global GNOME Full HD configuration\nAfter=display-manager.service\n[Service]\nType=oneshot\nExecStartPre=/bin/sleep 60\nExecStart=/usr/bin/python3 '+str(HERE/'configure-debian-display.py')+' finalize\nTimeoutStartSec=900\nRestart=on-failure\nRestartSec=15\n[Install]\nWantedBy=graphical.target\n'
    changed_boot=write('/etc/systemd/system/vamp-display-boot.service',boot_unit)
    changed_sync=write('/etc/systemd/system/vamp-display-sync.service',sync_unit)
    if changed_boot or changed_sync:subprocess.run(['systemctl','enable','vamp-display-boot.service','vamp-display-sync.service'],check=True)
    canonical=Path('/etc/vamp/monitors.xml')
    if canonical.exists():distribute(canonical)
    return {'status':'configured','connectors':ports,'kernel_video':video,'autologin':'vboxuser','automatic_sleep':False,'screen_blanking':False,'automatic_lock':False}

def distribute(source):
    root=ET.parse(source).getroot()
    monitors=root.findall('.//monitor')
    if not monitors or any(m.findtext('mode/width')!='1920' or m.findtext('mode/height')!='1080' for m in monitors):
        raise RuntimeError('Refusing to distribute monitors.xml without Full HD monitor modes')
    if any(float(node.text or '1')!=1 for node in root.findall('.//scale')):raise RuntimeError('Expected GNOME display scale 1')
    accounts=[]
    for name in ['Debian-gdm','gdm','gdm3']:
        try:accounts.append(pwd.getpwnam(name))
        except KeyError:pass
    destinations={Path('/etc/xdg/monitors.xml'):(0,0),Path('/etc/skel/.config/monitors.xml'):(0,0)}
    owner=(accounts[0].pw_uid,accounts[0].pw_gid) if accounts else (0,0)
    for folder in ['/var/lib/gdm','/var/lib/gdm3']:destinations[Path(folder)/'.config/monitors.xml']=owner
    for account in accounts:destinations[Path(account.pw_dir)/'.config/monitors.xml']=(account.pw_uid,account.pw_gid)
    for account in pwd.getpwall():
        if 1000<=account.pw_uid<65534 and Path(account.pw_dir).is_dir():destinations[Path(account.pw_dir)/'.config/monitors.xml']=(account.pw_uid,account.pw_gid)
    for path,(uid,gid) in destinations.items():
        path.parent.mkdir(parents=True,exist_ok=True)
        if uid:os.chown(path.parent,uid,gid)
        if source.resolve()!=path.resolve():shutil.copyfile(source,path)
        path.chmod(0o644);os.chown(path,uid,gid)
    return [str(path) for path in destinations]

def finalize():
    account=pwd.getpwnam('vboxuser');runtime='/run/user/'+str(account.pw_uid)
    environment={**os.environ,'HOME':account.pw_dir,'XDG_RUNTIME_DIR':runtime,'DBUS_SESSION_BUS_ADDRESS':'unix:path='+runtime+'/bus','DISPLAY':':0','XDG_SESSION_TYPE':'x11'}
    for _ in range(60):
        if Path(runtime+'/bus').exists():break
        time.sleep(5)
    else:raise RuntimeError('Automatic GNOME login session did not become ready')
    display_result=Path(account.pw_dir)/'.local/share/vamp/display/persistent-result.json'
    for script in ['session-policy.py','apply-display.py']:
        assignments=[key+'='+environment[key] for key in ['HOME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','DISPLAY','XDG_SESSION_TYPE']]
        if script=='apply-display.py':
            assignments.append('VAMP_GNOME_UNATTENDED=1')
        command=['/usr/sbin/runuser','-u','vboxuser','--','env',*assignments,'python3',str(HERE/script)]
        if script=='apply-display.py':
            command+=['--output',str(display_result)]
        subprocess.run(command,check=True)
    display=json.loads(display_result.read_text())
    if not display.get('resolution_verified') or not display.get('monitors_xml'):
        raise RuntimeError('GNOME did not provide a verified monitor configuration')
    canonical=Path('/etc/vamp/monitors.xml')
    write(canonical,display['monitors_xml']+'\n')
    paths=distribute(canonical)
    result=prepare();result['monitors_xml']=paths
    state=Path('/var/lib/vamp/display-persistence.json');state.parent.mkdir(parents=True,exist_ok=True);state.write_text(json.dumps(result,indent=2)+'\n')
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['prepare','finalize']);args=parser.parse_args()
    if os.geteuid()!=0:parser.error('Run this inside the Debian guest as root')
    print(json.dumps(prepare() if args.action=='prepare' else finalize()))
