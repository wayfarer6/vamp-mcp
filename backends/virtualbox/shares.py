"""Owner-local recording share and bounded source inspection for MCP."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import sys
try:
    from .provision import parse
except ImportError:
    from provision import parse
try:
    from .display import command
except ImportError:
    from display import command


def folder(vm):
    slug=re.sub(r'[^A-Za-z0-9_.-]','_',vm)[:48] or 'vm'
    return Path(os.environ.get('VAMP_DATA_DIR',Path.home()/'VAMP'))/'recordings'/(slug+'-'+hashlib.sha256(vm.encode()).hexdigest()[:8])


def prepare(vm,run=command):
    info=parse(run('showvminfo',vm,'--machinereadable'))
    destination=folder(vm).resolve();destination.mkdir(parents=True,exist_ok=True)
    # Reuse an existing share only if it refers to this exact directory.
    for key,name in info.items():
        if key.startswith('SharedFolderName') and name=='VAMPRecords':
            pathkey=key.replace('SharedFolderName','SharedFolderPath')
            if Path(info.get(pathkey,'')).resolve()!=destination:raise ValueError('VAMPRecords already maps elsewhere; refusing to replace it')
            return details(vm,destination,already_configured=True)
    args=['sharedfolder','add',vm,'--name','VAMPRecords','--hostpath',str(destination),'--automount']
    transient=info.get('VMState')=='running'
    if transient:args+=['--transient']
    run(*args)
    return details(vm,destination,transient=transient)


def details(vm,path,**extra):
    return {'status':'share_configured','vm':vm,'host_path':str(path),
      'windows_path':r'\\VBOXSVR\VAMPRecords','linux_path':'/media/sf_VAMPRecords',
      'linux_alternative':'~/VAMP-Shared','mount_verified':False,
      'notice':'Guest Additions/shared-folder support is required. A transient running-VM share must be re-added next start/session.',**extra}


def inspect(vm,filename=None,offset=0,limit=8000):
    destination=folder(vm).resolve()
    if not destination.is_dir():return {'status':'share_not_prepared','files':[]}
    if filename is None:
        files=[{'name':p.name,'bytes':p.stat().st_size,'host_path':str(p)} for p in sorted(destination.iterdir()) if p.is_file() and p.suffix in ('.py','.json')]
        return {'status':'observed','host_path':str(destination),'files':files[:50],'total':len(files)}
    if Path(filename).name!=filename or not filename.endswith(('.py','.json')):raise ValueError('Choose one recording filename')
    target=(destination/filename).resolve()
    if target.parent!=destination or not target.is_file() or target.stat().st_size>5_000_000:raise ValueError('Invalid recording or size')
    if offset<0 or not 1<=limit<=8000:raise ValueError('Invalid pagination')
    source=target.read_text(encoding='utf-8-sig')
    if target.suffix=='.py':ast.parse(source)
    else:json.loads(source)
    return {'status':'read_for_review','host_path':str(target),'source_executed':False,
      'offset':offset,'total_characters':len(source),'source':source[offset:offset+limit],
      'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}

if __name__=='__main__':
    try:
        args=json.load(sys.stdin);op=args.pop('action','prepare')
        print(json.dumps((prepare if op=='prepare' else inspect)(**args)))
    except Exception as exc:print(json.dumps({'status':'failed','error':str(exc)}));sys.exit(1)
