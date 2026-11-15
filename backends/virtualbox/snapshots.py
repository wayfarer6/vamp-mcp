"""Explicit snapshot lifecycle; never stop or restore a running VM automatically."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
try:
    from .provision import executable,parse
except ImportError:
    from provision import executable,parse


def command(*args):
    result=subprocess.run([executable(),*map(str,args)],capture_output=True,text=True,timeout=300)
    if result.returncode:
        if args[:1]==('snapshot',) and 'does not have any snapshots' in result.stdout+result.stderr:return ''
        raise RuntimeError(result.stderr.strip()[:500] or result.stdout.strip()[:500])
    return result.stdout


def manage(vm,action='list',name=None,confirm_restore=False,initial=False,run=command):
    info=parse(run('showvminfo',vm,'--machinereadable'))
    result={'vm':vm,'action':action}
    if action=='list':
        text=run('snapshot',vm,'list','--machinereadable')
        return {**result,'status':'observed','snapshots':parse(text),'empty':not bool(text.strip())}
    if action=='take':
        if not name or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_. -]{0,79}',name):raise ValueError('Provide a clear snapshot name (1-80 ASCII letters/digits/space/._-)')
        if initial and name!='VAMP-initial':raise ValueError('Use snapshot name VAMP-initial when marking a baseline')
        existing=run('snapshot',vm,'list','--machinereadable')
        if name in parse(existing).values():raise ValueError('Snapshot name already exists; use another name')
        args=['snapshot',vm,'take',name,'--description','VAMP explicit session checkpoint; later changes are not included.']
        if info.get('VMState')=='running':args+=['--live']
        run(*args)
        return {**result,'status':'snapshot_created','name':name,'initial':initial,
                'space_notice':'Differencing disks grow with changes; a running-VM snapshot can also store RAM. A snapshot is not an independent backup.'}
    if action in ('restore','restore_initial'):
        if not confirm_restore:raise ValueError('Ask the user to confirm the exact restore target and loss of later changes first')
        if info.get('VMState')!='poweroff':raise ValueError('Restore requires a powered-off VM; explicitly shut it down first, never auto-power-off')
        target='VAMP-initial' if action=='restore_initial' else name
        if not target:raise ValueError('Choose an exact snapshot name/UUID')
        rows=parse(run('snapshot',vm,'list','--machinereadable'))
        if target not in rows.values():raise ValueError('Snapshot target does not exist')
        run('snapshot',vm,'restore',target)
        return {**result,'status':'snapshot_restored','target':target,'vm_started':False,
                'notice':'Changes after the target snapshot are no longer the active state.'}
    raise ValueError('Unknown snapshot action')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.parse_args()
    try:print(json.dumps(manage(**json.load(sys.stdin))))
    except Exception as exc:print(json.dumps({'status':'failed','error':str(exc)}));sys.exit(1)
