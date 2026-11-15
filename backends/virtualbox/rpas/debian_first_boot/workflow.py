"""OCR-guarded Debian first desktop login and mirror setup; no guest agent required."""
import asyncio
import json
import os
from pathlib import Path
import re
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
sys.path.insert(0,str(Path(__file__).resolve().parents[4]))
from client import request


def _setup_debian_network(vm,login_required=False,script_path='/opt/rpa-recorder-setup/configure-debian-mirrors.py',timeout=180):
    from model_daemon import request as vision_request
    root=Path(__file__).resolve().parents[4]/'artifacts/debian-first-boot'
    root.mkdir(parents=True,exist_ok=True)
    count=0
    def call(tool,args):return asyncio.run(request(tool,args))
    def key(keys):call('vm_keyboard_scancode',{'vm':vm,'keys':keys})
    def write(text):call('vm_keyboard_type',{'vm':vm,'text':text,'chunkSize':10,'delayMs':100})
    def observe():
        nonlocal count
        count+=1;image=root/f'{count:02d}.png'
        asyncio.run(request('vm_screenshot',{'vm':vm},str(image)))
        data=vision_request('ocr',{'op':'predict','image':str(image),'languages':['en']})
        (root/f'{count:02d}.json').write_text(json.dumps(data,indent=2))
        return '\n'.join(line['text'] for line in data['lines'])
    password=os.environ.get('VAMP_GUEST_PASSWORD','password123!')
    if str(login_required).lower() in ('true','1','yes'):
        key('enter');time.sleep(2)
        visible=observe()
        if not re.search(r'password',visible,re.I):raise RuntimeError('Expected English password prompt; no password typed')
        write(password);key('enter');time.sleep(6)
    visible=''
    for launch_attempt in range(2):
        key('esc');key('esc');time.sleep(1)
        key('alt+f2');time.sleep(1);write('gnome-terminal');key('enter');time.sleep(3)
        key('esc');key('esc');time.sleep(1)
        visible=observe()
        if re.search(r'(@|\$|root)',visible):break
    else:raise RuntimeError('Terminal prompt not observed; refusing shell commands')
    if not re.search(r'root@',visible):
        write('su - root');key('enter');time.sleep(1)
        if not re.search(r'password',observe(),re.I):raise RuntimeError('Root password prompt missing')
        write(os.environ.get('VAMP_ROOT_PASSWORD',password));key('enter');time.sleep(2)
        if not re.search(r'root@',observe()):raise RuntimeError('Root shell not verified')
    if not script_path.startswith('/') or any(x in script_path for x in "'\n\r"):raise ValueError('Choose an absolute guest script path')
    mount_prefix=''
    if '/VAMP-Shared/' in script_path:
        directory=script_path.split('/VAMP-Shared/',1)[0]+'/VAMP-Shared'
        mount_prefix=f"mountpoint -q '{directory}' || (mkdir -p '{directory}' && mount -t vboxsf -o uid=$(id -u vboxuser),gid=$(id -g vboxuser) VAMPRecords '{directory}'); "
    write(f"clear; {mount_prefix}python3 '{script_path}' && apt-get update && printf '\\126\\101\\115\\120\\137\\101\\120\\124\\137\\117\\113\\n'");key('enter')
    deadline=time.monotonic()+int(timeout)
    while time.monotonic()<deadline:
        visible=observe()
        # A typed shell command itself is not success: require the output marker on its own OCR line.
        lines=[s.strip() for s in visible.splitlines()]
        if re.search(r'Permission denied|No such file|not found|Some index files failed',visible,re.I):
            raise RuntimeError('Mirror setup did not finish cleanly; inspect OCR evidence')
        if 'VAMP_APT_OK' in lines:
            result={'status':'succeeded','verification':'ocr_only','vm':vm,'details':str(root),'snapshots_created':False}
            (root/'result.json').write_text(json.dumps(result,indent=2));return result
        time.sleep(3)
    raise RuntimeError('APT verification timed out; inspect current terminal before rerunning')


def setup_debian_network(vm,login_required=False,script_path='/opt/rpa-recorder-setup/configure-debian-mirrors.py',timeout=180):
    result_file=Path(__file__).resolve().parents[4]/'artifacts/debian-first-boot/result.json'
    result_file.parent.mkdir(parents=True,exist_ok=True)
    result_file.write_text(json.dumps({'status':'running','vm':vm}))
    try:return _setup_debian_network(vm,login_required,script_path,timeout)
    except Exception as exc:
        result_file.write_text(json.dumps({'status':'failed','vm':vm,'error':str(exc)}))
        raise
