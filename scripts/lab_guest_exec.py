#!/usr/bin/env python3
"""Run an explicit lab setup command via QGA; GUI RPA still uses guest devices."""
import argparse
import base64
import json
import subprocess
import time


def call(vm, operation, **arguments):
    payload = {'execute':operation}
    if arguments: payload['arguments'] = arguments
    result = subprocess.run(['virsh','-c','qemu:///session','qemu-agent-command',vm,json.dumps(payload)],
        capture_output=True,text=True,check=True,timeout=40)
    response = json.loads(result.stdout)
    if 'error' in response: raise RuntimeError(response['error'])
    return response['return']


def execute(vm, executable, args, timeout=120):
    pid = call(vm, 'guest-exec', path=executable, arg=args, **{'capture-output':True})['pid']
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        result = call(vm,'guest-exec-status',pid=pid)
        if result.get('exited'):
            return {'exitcode':result.get('exitcode'), **{k:base64.b64decode(result.get(k+'-data','')).decode(errors='replace') for k in ('out','err')}}
        time.sleep(.3)
    raise TimeoutError(f'Lab command PID {pid} still running; inspect before retrying')


if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('vm');p.add_argument('--timeout',type=int,default=120);p.add_argument('command',nargs=argparse.REMAINDER)
    a=p.parse_args();print(json.dumps(execute(a.vm,a.command[0],a.command[1:],a.timeout),ensure_ascii=False,indent=2))
