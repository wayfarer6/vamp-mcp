"""Bounded binary exchange over QEMU Guest Agent. Contents never enter MCP results."""
import base64
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import time
import uuid

MAX_BYTES=1024**3
CHUNK=64*1024


def relative_path(value):
    if not value or '\\' in value or ':' in value or any(ord(c)<32 for c in value):
        raise ValueError('Use a relative exchange path with / separators')
    path=PurePosixPath(value)
    if path.is_absolute() or any(part in ('..','.') for part in value.split('/')):
        raise ValueError('Exchange path must stay inside the exchange folder')
    return path.as_posix()


# This fixed program receives paths as argv values, never interpolated code.
GUEST_PROGRAM=r'''
import hashlib,json,os,pathlib,sys
op,base,relative=sys.argv[1:4]
root=pathlib.Path(base).resolve();root.mkdir(parents=True,exist_ok=True)
if os.name!='nt':os.chmod(root,0o1777)
p=(root/relative).resolve();p.relative_to(root)
if op=='prepare':
 print(json.dumps({'root':str(root),'exists':root.is_dir()}))
elif op=='stage':
 p.parent.mkdir(parents=True,exist_ok=True)
 if os.name!='nt':os.chmod(p.parent,0o1777)
 print(json.dumps({'path':str(p)}))
elif op=='commit':
 target=(root/sys.argv[4]).resolve();target.relative_to(root)
 if sys.argv[5]=='1':os.replace(p,target)
 else:os.link(p,target);p.unlink()
 print(json.dumps({'bytes':target.stat().st_size,'sha256':hashlib.file_digest(target.open('rb'),'sha256').hexdigest(),'path':str(target)}))
elif op=='metadata':
 print(json.dumps({'bytes':p.stat().st_size,'mtime_ns':p.stat().st_mtime_ns,'path':str(p)}))
elif op=='remove':
 p.unlink(missing_ok=True);print('{}')
'''


class GuestAgent:
    def __init__(self,controller,vm_name):
        if vm_name not in controller.config['vms']:raise ValueError('VM is not configured')
        self.profile=controller.config['vms'][vm_name]
        if self.profile['backend'] not in ('vnc','spice'):raise ValueError('QEMU guest file transport requires a KVM guest')
        try:
            import libvirt,libvirt_qemu
        except ImportError:
            raise RuntimeError('Install the host libvirt Python bindings to use QEMU guest file transfer') from None
        self.module=libvirt_qemu
        self.connection=libvirt.open(controller.config.get('libvirt_uri','qemu:///system'))
        self.domain=self.connection.lookupByName(vm_name)
        windows=self.profile['guest_os'].startswith('windows')
        self.python=self.profile.get('guest_python',r'C:\ProgramData\VAMP\Python312\python.exe' if windows else '/usr/bin/python3')
        self.root=self.profile.get('exchange_guest_path',r'C:\Users\Public\VAMP-Exchange' if windows else '/var/tmp/vamp-exchange')

    def close(self):self.connection.close()

    def call(self,operation,**arguments):
        request={'execute':operation}
        if arguments:request['arguments']=arguments
        try:
            response=json.loads(self.module.qemuAgentCommand(self.domain,json.dumps(request),30,0))
        except Exception:
            raise RuntimeError('QEMU guest file channel unavailable; verify the guest agent and virtio-serial driver') from None
        if 'error' in response:raise RuntimeError(response['error'].get('desc','QEMU guest agent operation failed')[:300])
        return response['return']

    def program(self,operation,path='',*extra):
        result=self.call('guest-exec',path=self.python,arg=['-c',GUEST_PROGRAM,operation,self.root,path,*extra],**{'capture-output':True})
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            state=self.call('guest-exec-status',pid=result['pid'])
            if state.get('exited'):
                if state.get('exitcode'):
                    # Report a bounded diagnostic; never echo file contents.
                    error=base64.b64decode(state.get('err-data','')).decode(errors='replace')
                    raise RuntimeError('Guest file operation failed: '+error.splitlines()[-1][:200] if error else 'Guest file operation failed')
                output=base64.b64decode(state.get('out-data',''))
                if len(output)>4096:raise ValueError('Unexpected guest metadata response')
                return json.loads(output)
            time.sleep(.05)
        raise TimeoutError('Guest file metadata operation timed out')


def put(controller,vm_name,local_path,guest_path,overwrite=False):
    relative=relative_path(guest_path);source=Path(local_path).expanduser().resolve(strict=True)
    if not source.is_file() or source.stat().st_size>MAX_BYTES:raise ValueError('Choose a file no larger than 1 GiB')
    agent=GuestAgent(controller,vm_name);handle=None;temporary=str(PurePosixPath(relative).parent/('.vamp-transfer-'+uuid.uuid4().hex))
    digest=hashlib.sha256();count=0
    try:
        staged=agent.program('stage',temporary)
        handle=agent.call('guest-file-open',path=staged['path'],mode='wb')
        with source.open('rb') as stream:
            while chunk:=stream.read(CHUNK):
                digest.update(chunk);count+=len(chunk)
                if count>MAX_BYTES:raise ValueError('Source file grew beyond the 1 GiB transfer limit')
                offset=0
                while offset<len(chunk):
                    result=agent.call('guest-file-write',handle=handle,**{'buf-b64':base64.b64encode(chunk[offset:]).decode()})
                    written=result['count']
                    if not 0<written<=len(chunk)-offset:raise RuntimeError('Guest file write made no valid progress')
                    offset+=written
        agent.call('guest-file-close',handle=handle);handle=None
        result=agent.program('commit',temporary,relative,'1' if overwrite else '0')
        if result['sha256']!=digest.hexdigest() or result['bytes']!=count:raise RuntimeError('Transferred file checksum mismatch')
        return {'status':'copied','backend':'kvm','direction':'host_to_guest','bytes':count,'sha256':digest.hexdigest(),'guest_path':result['path'],'verified':True}
    finally:
        if handle is not None:
            try:agent.call('guest-file-close',handle=handle)
            except Exception:pass
        try:agent.program('remove',temporary)
        except Exception:pass
        agent.close()


def get(controller,vm_name,guest_path,local_path,overwrite=False):
    relative=relative_path(guest_path);destination=Path(local_path).expanduser().resolve()
    if destination.exists() and not overwrite:raise FileExistsError('Host destination exists; overwrite was not requested')
    destination.parent.mkdir(parents=True,exist_ok=True)
    temporary=destination.with_name('.vamp-transfer-'+uuid.uuid4().hex)
    agent=GuestAgent(controller,vm_name);handle=None;digest=hashlib.sha256();count=0
    try:
        before=agent.program('metadata',relative)
        if before['bytes']>MAX_BYTES:raise ValueError('Guest file exceeds the 1 GiB transfer limit')
        handle=agent.call('guest-file-open',path=before['path'],mode='rb')
        with os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as stream:
            while True:
                result=agent.call('guest-file-read',handle=handle,count=CHUNK)
                chunk=base64.b64decode(result.get('buf-b64',''),validate=True)
                if len(chunk)!=result['count']:raise RuntimeError('Invalid guest file read size')
                count+=len(chunk)
                if count>MAX_BYTES:raise ValueError('Guest file grew beyond the transfer limit')
                digest.update(chunk);stream.write(chunk)
                if result.get('eof'):break
                if not chunk:raise RuntimeError('Guest file read made no progress')
            stream.flush();os.fsync(stream.fileno())
        agent.call('guest-file-close',handle=handle);handle=None
        after=agent.program('metadata',relative)
        if before!=after or count!=before['bytes']:raise RuntimeError('Guest file changed during transfer')
        if overwrite:os.replace(temporary,destination)
        else:os.link(temporary,destination);temporary.unlink()
        return {'status':'copied','backend':'kvm','direction':'guest_to_host','bytes':count,'sha256':digest.hexdigest(),'local_path':str(destination),'verified':True}
    finally:
        if handle is not None:
            try:agent.call('guest-file-close',handle=handle)
            except Exception:pass
        temporary.unlink(missing_ok=True);agent.close()


def prepare(controller,vm_name):
    agent=GuestAgent(controller,vm_name)
    try:
        agent.call('guest-ping');result=agent.program('prepare')
        return {'status':'ready','backend':'kvm','guest_path':result['root'],'transport':'qemu_guest_agent','bidirectional':True}
    finally:agent.close()
