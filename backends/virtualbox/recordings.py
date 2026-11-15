"""Import an explicitly chosen guest recording via existing Guest Additions; never replay."""
import ast
import hashlib
import json
import os
from pathlib import Path,PureWindowsPath
import subprocess
import uuid
try:
    from .provision import ROOT,executable
except ImportError:
    from provision import ROOT,executable


def import_recording(vm,guest_path,username='vboxuser'):
    normalized=guest_path.replace('\\','/')
    parts=normalized.split('/')
    if '..' in parts or 'RPA-Recorder' not in parts or not normalized.endswith(('.py','.handoff.json')):
        raise ValueError('Choose a Python/.handoff.json file under the guest RPA-Recorder folder')
    folder=ROOT/'artifacts/imported-recordings'/uuid.uuid4().hex[:12];folder.mkdir(parents=True)
    destination=folder/PureWindowsPath(guest_path).name
    password=os.environ.get('VAMP_GUEST_PASSWORD','password123!')
    result=subprocess.run([executable(),'guestcontrol',vm,'copyfrom','--username',username,
        '--password',password,'--target-directory',str(destination),guest_path],capture_output=True,text=True,timeout=90)
    if result.returncode:raise RuntimeError('Guest recording transfer failed; check Guest Additions, guest path and authorized VM account. '+result.stderr[:200])
    if not destination.is_file() or destination.stat().st_size>5_000_000:
        destination.unlink(missing_ok=True);raise ValueError('Expected a recording under 5 MB')
    content=destination.read_text(encoding='utf-8-sig')
    if destination.suffix=='.py':ast.parse(content)
    else:json.loads(content)
    destination.chmod(0o600)
    return {'status':'imported_for_review','host_path':str(destination),'guest_path':guest_path,
            'sha256':hashlib.sha256(destination.read_bytes()).hexdigest(),'source_executed':False,
            'next_action':'Read the imported text without executing it. Review credentials and apply the static converter for a supported backend.'}

if __name__=='__main__':
    import sys
    try:print(json.dumps(import_recording(**json.load(sys.stdin))))
    except Exception as exc:print(json.dumps({'status':'failed','error':str(exc)}));sys.exit(1)
