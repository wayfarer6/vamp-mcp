"""Binary exchange through a VM-scoped Guest Additions shared folder."""
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import re
import shutil
import sys
import uuid
try:
    from .display import command
    from .provision import parse
except ImportError:
    from display import command
    from provision import parse

MAX_BYTES=1024**3


def exchange_root(vm):
    name=re.sub(r'[^A-Za-z0-9_.-]','_',vm)[:40]+'-'+hashlib.sha256(vm.encode()).hexdigest()[:8]
    return (Path(os.environ.get('VAMP_DATA_DIR',Path.home()/'VAMP'))/'exchange'/name).resolve()


def safe_path(root,relative):
    path=PurePosixPath(relative)
    if not relative or path.is_absolute() or '\\' in relative or ':' in relative or any(p in ('..','.') for p in relative.split('/')):
        raise ValueError('Use a relative path inside VAMPFiles')
    target=(root/path).resolve()
    if not target.is_relative_to(root):raise ValueError('Shared file path escapes the exchange directory')
    return target


def prepare(vm,run=command):
    info=parse(run('showvminfo',vm,'--machinereadable'))
    root=exchange_root(vm);root.mkdir(parents=True,exist_ok=True)
    present=False
    for key,value in info.items():
        if key.startswith('SharedFolderName') and value=='VAMPFiles':
            mapped=Path(info.get(key.replace('SharedFolderName','SharedFolderPath'),'')).resolve()
            if mapped!=root:raise ValueError('VAMPFiles is mapped elsewhere; refusing to replace it')
            present=True
    if not present:
        args=['sharedfolder','add',vm,'--name','VAMPFiles','--hostpath',str(root),'--automount']
        if info.get('VMState')=='running':args+=['--transient']
        run(*args)
    return {'status':'share_configured','backend':'virtualbox','vm_name':vm,'host_path':str(root),
            'windows_path':r'\\VBOXSVR\VAMPFiles','linux_path':'/media/sf_VAMPFiles',
            'guest_mount_verified':False,'requires':'VirtualBox Guest Additions shared-folder driver'}


def copy_file(source,destination,overwrite):
    source=Path(source).resolve(strict=True);destination=Path(destination)
    if not source.is_file() or source.stat().st_size>MAX_BYTES:raise ValueError('Choose a file no larger than 1 GiB')
    if destination.exists() and not overwrite:raise FileExistsError('Destination exists; overwrite was not requested')
    destination.parent.mkdir(parents=True,exist_ok=True)
    temporary=destination.with_name('.vamp-transfer-'+uuid.uuid4().hex)
    try:
        with source.open('rb') as incoming,os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as outgoing:
            count=0;digest=hashlib.sha256()
            while chunk:=incoming.read(64*1024):
                count+=len(chunk)
                if count>MAX_BYTES:raise ValueError('File grew beyond the transfer limit')
                digest.update(chunk);outgoing.write(chunk)
            outgoing.flush();os.fsync(outgoing.fileno())
        if overwrite:os.replace(temporary,destination)
        else:os.link(temporary,destination);temporary.unlink()
        return {'bytes':count,'sha256':digest.hexdigest()}
    finally:temporary.unlink(missing_ok=True)


def put(vm,local_path,guest_path,overwrite=False,run=command):
    share=prepare(vm,run);target=safe_path(exchange_root(vm),guest_path)
    copied=copy_file(local_path,target,overwrite)
    return {**share,**copied,'status':'staged','direction':'host_to_guest','relative_path':guest_path,
            'shared_file':str(target),'guest_delivery_verified':False}


def get(vm,guest_path,local_path,overwrite=False,run=command):
    share=prepare(vm,run);source=safe_path(exchange_root(vm),guest_path)
    copied=copy_file(source,Path(local_path).expanduser().resolve(),overwrite)
    return {**copied,'status':'copied','backend':'virtualbox','direction':'guest_to_host',
            'local_path':str(Path(local_path).expanduser().resolve()),'shared_source':str(source),'host_copy_verified':True}

if __name__=='__main__':
    try:
        values=json.load(sys.stdin);operation=values.pop('action');print(json.dumps({'prepare':prepare,'put':put,'get':get}[operation](**values)))
    except Exception as error:
        print(json.dumps({'status':'error','error_summary':str(error)[:300]}));sys.exit(1)
