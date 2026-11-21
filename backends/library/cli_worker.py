"""Guest-side stdio worker for an operator-bound, rootless, offline CLI workspace."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import tempfile
import time
import subprocess
import sys
import uuid

CONFIG = Path('/etc/vamp/cli-workspace.json')
PODMAN = '/usr/bin/podman'
LIMIT = 1024 * 1024

# Both phases get fresh tmpfs storage. Only the selected artifact crosses phases.
BOOT = r"""
import base64, json, os, pathlib, subprocess, sys
p=json.load(sys.stdin)
root=pathlib.Path('/work')
src=root/'src'
out=root/'outputs'
src.mkdir()
out.mkdir()
for name,body in p['files'].items():
    (src/name).write_text(body,encoding='utf8')
checks=[]
artifact=None
env={**os.environ,'HOME':'/work','TMPDIR':'/tmp','VAMP_OUTPUT_DIR':str(out)}
if p['phase']=='verify':
    if p['artifact']:
        (out/p['name']).write_bytes(base64.b64decode(p['artifact']['data'],validate=True))
    command=['python3','-I',str(src/'verify.py')]
else:
    command=(['node',str(src/'main.cjs')] if p['runner']=='playwright' else ['python3','-I',str(src/'main.py')])
with open(root/'report','w+b') as report:
    try:
        proc=subprocess.run(command,cwd=out,env=env,input=json.dumps(p['inputs']).encode(),stdout=report,stderr=subprocess.DEVNULL,timeout=45)
    except subprocess.TimeoutExpired:
        print(json.dumps({'exit_code':124,'checks':[],'artifact':None}))
        sys.exit(0)
    if proc.returncode==0 and p['phase']=='verify':
        report.seek(0)
        checks=json.loads(report.read(16385))
        if not isinstance(checks,list) or not 0<len(checks)<=64: raise ValueError('checks')
if proc.returncode==0 and p['phase']=='run' and p['name']:
    import stat
    with os.fdopen(os.open(out/p['name'],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):raise ValueError('output type')
        data=f.read(1048577)
        if len(data)>1048576:raise ValueError('output size')
    artifact={'name':p['name'],'data':base64.b64encode(data).decode()}
print(json.dumps({'exit_code':proc.returncode,'checks':checks,'artifact':artifact}))
"""


def phase(payload, image):
    name = 'vamp-cli-' + uuid.uuid4().hex
    args = [PODMAN, 'run', '--rm', '--pull=never', '--name', name, '--network=none',
            '--read-only', '--user=65534:65534', '--cap-drop=all', '--security-opt=no-new-privileges',
            '--pids-limit=128', '--memory=768m', '--cpus=1', '--timeout=55',
            '--tmpfs', '/work:rw,nosuid,nodev,size=32m,mode=1777', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
            '--entrypoint', 'python3', '-i', image, '-I', '-c', BOOT]
    with tempfile.TemporaryFile() as request:
        request.write(json.dumps(payload).encode())
        request.seek(0)
        with subprocess.Popen(args, stdin=request, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
            deadline = time.monotonic() + 65
            output = bytearray()
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(child.stdout, selectors.EVENT_READ)
                    while len(output) <= 2 * LIMIT:
                        if not selector.select(max(0, deadline - time.monotonic())):
                            raise subprocess.TimeoutExpired('sandbox', 65)
                        chunk = os.read(child.stdout.fileno(), 65536)
                        if not chunk:
                            break
                        output.extend(chunk)
                if len(output) > 2 * LIMIT:
                    raise ValueError('sandbox output limit')
                code = child.wait(timeout=max(0, deadline - time.monotonic()))
            finally:
                if child.poll() is None:
                    child.kill()
            if code in (124, 137):
                raise subprocess.TimeoutExpired('sandbox', 55)
            if code:
                raise ValueError('sandbox')
            return json.loads(output)


def execute(request, config):
    for key in ('backend', 'vm_id', 'workspace_id', 'image'):
        if request[key] != config[key]:
            raise ValueError('binding')
    image = config['image']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise ValueError('image')
    workflow = request['workflow']
    files = workflow['files']
    if not 1 <= len(files) <= 24 or not all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}', k)
                                              and isinstance(v,str) for k,v in files.items()):
        raise ValueError('package')
    runner = workflow['runner']
    lock = {'python':'requirements.lock', 'playwright':'package-lock.json'}[runner]
    if config['locks'].get(runner) != hashlib.sha256(files[lock].encode()).hexdigest():
        raise ValueError('dependency lock')
    values = request['inputs']
    if set(values) != set(workflow['inputs']) or any(not isinstance(v,str) or len(v)>10000 for v in values.values()):
        raise ValueError('inputs')
    name = values[workflow['output_input']] if workflow['output_input'] is not None else None
    if name is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}',name):
        raise ValueError('filename')
    payload = dict(runner=runner, files=files, inputs=values, name=name, phase='run')
    result = phase(payload, image)
    response = {'exit_code':result['exit_code'], 'status':'failed', 'checks':[]}
    if result['exit_code']:
        if result['exit_code']==124:
            response['status']='timed_out'
        return response
    if result['artifact'] is not None:
        response['artifact'] = result['artifact']
    if 'verify.py' not in files:
        response['status'] = 'completed_unverified'
        return response
    verified = phase({**payload, 'phase':'verify', 'artifact':result['artifact']}, image)
    if verified['exit_code']==124:
        response['status']='timed_out'
        return response
    checks = verified['checks']
    if not all(isinstance(c,dict) and isinstance(c.get('passed'),bool) and
               re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',c.get('name','')) for c in checks):
        raise ValueError('verification report')
    response['checks'] = [{'name':c['name'],'passed':c['passed']} for c in checks]
    if verified['exit_code']==0 and checks and all(c['passed'] for c in checks):
        response['status']='verified'
    return response


def main():
    try:
        info = CONFIG.lstat()
        if os.getuid()==0 or info.st_uid!=0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022:
            raise ValueError('operator binding')
        raw=sys.stdin.buffer.read(2*LIMIT+1)
        if len(raw)>2*LIMIT:
            raise ValueError('request size')
        result=execute(json.loads(raw), json.loads(CONFIG.read_text()))
    except subprocess.TimeoutExpired:
        result={'status':'timed_out','exit_code':None}
    except (ValueError, KeyError, TypeError, OSError):
        result={'status':'failed','exit_code':None}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
