"""Local authorized headless Debian Podman builder. No startup work on imports."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import uuid

HERE=Path(__file__).resolve().parent
sys.path[:0]=[str(HERE.parent),str(HERE.parent.parent/'vagrant'),str(HERE.parent.parent/'common')]
from profile import BOX_TEMPLATE,render_profile
from toolchain import home,environment,install
from podman_handoff import render_vagrantfile
from guest_install import require_install_host

ID=re.compile(r'[a-f0-9]{32}')
SHA=re.compile(r'[a-f0-9]{64}')
GIB=1024**3


def jobs():
    return home()/'podman-hosts'


def job_folder(id):
    if not isinstance(id,str) or ID.fullmatch(id) is None:
        raise ValueError('Invalid Debian VM build ID')
    return jobs()/id


def save(folder, state):
    temporary=folder/'job.tmp'
    temporary.write_text(json.dumps(state,indent=2)+'\n',encoding='utf8')
    temporary.replace(folder/'job.json')


def local_tool(command):
    if sys.platform=='win32':
        pf=Path(os.environ.get('ProgramFiles','C:/Program Files'))
        drive=Path(os.environ.get('SystemDrive','C:')+'/')
        win=Path(os.environ.get('SystemRoot','C:/Windows'))
        candidates={'vagrant':[drive/'HashiCorp/Vagrant/bin/vagrant.exe',pf/'HashiCorp/Vagrant/bin/vagrant.exe'],
                    'ssh-keygen':[win/'System32/OpenSSH/ssh-keygen.exe'],
                    'VBoxManage':[pf/'Oracle/VirtualBox/VBoxManage.exe']}
    else:
        candidates={k:[Path('/usr/bin')/k,Path('/usr/local/bin')/k] for k in ('vagrant','ssh-keygen','VBoxManage','virsh','qemu-system-x86_64')}
    for file in candidates.get(command,[]):
        if file.is_file() and file.resolve().is_absolute():
            return str(file.resolve())
    raise ValueError(f'Install {command} on this host before creating a Debian VM')


def free_ram():
    if sys.platform=='win32':
        class Memory(ctypes.Structure):
            _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(k,ctypes.c_ulonglong) for k in ('total','avail','pgtotal','pgavail','vtotal','vavail','vextra')]
        value=Memory()
        value.length=ctypes.sizeof(value)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value)):raise OSError('Cannot verify free host memory')
        return value.avail
    text=Path('/proc/meminfo').read_text()
    match=re.search(r'^MemAvailable:\s+(\d+) kB$',text,re.M)
    if not match:raise OSError('Cannot verify free host memory')
    return int(match[1])*1024


def assert_host(data):
    provider=data.get('provider')
    if provider not in ('virtualbox','kvm'):
        raise ValueError('Choose VirtualBox or Linux KVM (Vagrant libvirt)')
    if not (sys.platform=='win32' or sys.platform.startswith('linux')) or 'microsoft' in platform.release().lower():
        raise ValueError('Run the Debian VM builder on native Linux or Windows, not in WSL')
    require_install_host(provider)
    if free_ram()<6*GIB:
        raise ValueError('Free at least 6 GiB on the host before starting a 4 GiB Debian VM')
    anchor=home()
    while not anchor.exists() and anchor!=anchor.parent:anchor=anchor.parent
    if shutil.disk_usage(anchor).free<64*GIB:
        raise ValueError('This build needs at least 64 GiB available for its private box and separate VM')
    tools={name:local_tool(name) for name in ('vagrant','ssh-keygen')}
    if provider=='virtualbox':
        tools['VBoxManage']=local_tool('VBoxManage')
        try:
            active=subprocess.run([tools['VBoxManage'],'list','runningvms'],capture_output=True,text=True,check=True,timeout=15)
        except (subprocess.SubprocessError,OSError):
            raise ValueError('VirtualBox could not confirm the running VM inventory; check access on this host') from None
        if active.stdout.strip():
            raise ValueError('Stop other VirtualBox guests before starting the dedicated build')
    else:
        local_tool('virsh');local_tool('qemu-system-x86_64')
        if not os.access('/dev/kvm',os.R_OK|os.W_OK):
            raise ValueError('This Linux user cannot access /dev/kvm')
        try:
            plugins=subprocess.run([tools['vagrant'],'plugin','list'],capture_output=True,text=True,check=True,timeout=20)
        except (subprocess.SubprocessError,OSError):
            raise ValueError('Vagrant could not verify its libvirt plugin') from None
        if not re.search(r'^vagrant-libvirt\s+\(', plugins.stdout,re.M):
            raise ValueError('Install the Vagrant libvirt plugin on this Linux host before deploying')
    return tools


def check_request(data):
    if not isinstance(data,dict) or set(data)!={'provider','isoPath','isoSha256'}:
        raise ValueError('Choose a provider, local ISO, and independently verified SHA-256')
    value=data['isoPath']
    if not isinstance(value,str) or value.startswith(('\\\\','//')) or any(ord(c)<32 for c in value):
        raise ValueError('Select a local filesystem ISO')
    iso=Path(value)
    if not iso.is_absolute() or not iso.is_file() or iso.suffix.lower()!='.iso' or iso.is_symlink():
        raise ValueError('Select a real local Debian installer ISO file')
    if not isinstance(data['isoSha256'],str) or not SHA.fullmatch(data['isoSha256']):
        raise ValueError('Enter the independently verified Debian SHA-256')
    return {**data,'isoPath':str(iso.resolve(strict=True))}


def digest(file):
    with file.open('rb') as contents:return hashlib.file_digest(contents,'sha256').hexdigest()


def box_metadata(box,provider):
    if box.is_symlink() or not box.is_file():
        raise ValueError('Packer did not produce a provider-specific Vagrant box')
    meta=None;seen=set()
    with tarfile.open(box,'r|*') as archive:
        for member in archive:
            filename=member.name
            if filename in ('.','./') and member.isdir():continue
            pure=PurePosixPath(filename)
            if pure.is_absolute() or '..' in pure.parts or not pure.parts or len(pure.parts)!=1 or any(c in filename for c in ('\\',':')) or not member.isfile() or len(seen)>=20:
                raise ValueError('Unexpected box archive contents; no import was performed')
            filename=pure.name
            if filename in seen:raise ValueError('Duplicate box entry; no import was performed')
            seen.add(filename)
            if filename in ('metadata.json','Vagrantfile'):
                if member.size>16384:
                    raise ValueError('Unexpected box metadata')
                value=archive.extractfile(member).read()
                if filename=='metadata.json':meta=json.loads(value)
                elif value.decode('utf8').strip()!=BOX_TEMPLATE.strip():
                    raise ValueError('The box includes an unexpected executable Vagrantfile; no import was performed')
            elif not filename.lower().endswith(('.vmdk','.ovf','.mf','.img','.qcow2')):
                raise ValueError('Box contains an unexpected file; no import was performed')
    if not isinstance(meta,dict) or meta.get('provider')!=provider:
        raise ValueError('Generated box provider does not match Vagrant deployment')
    if provider=='virtualbox' and not (any(x.endswith('.ovf') for x in seen) and any(x.endswith('.vmdk') for x in seen)):
        raise ValueError('VirtualBox box is missing its VM configuration or disk')
    if provider=='libvirt' and not any(x.endswith(('.img','.qcow2')) for x in seen):
        raise ValueError('Libvirt box is missing its disk')
    return meta


def start(data):
    data=check_request(data)
    assert_host(data)
    base=jobs()
    base.mkdir(parents=True,exist_ok=True,mode=0o700)
    lock=base/'active.lock'
    jid=uuid.uuid4().hex
    try:
        with lock.open('x',encoding='utf8') as file:file.write(jid)
    except FileExistsError:raise ValueError('A Debian engine build is already reserved. Check its status before starting another.') from None
    folder=job_folder(jid)
    try:
        folder.mkdir(mode=0o700)
        (folder/'request.json').write_text(json.dumps(data)+'\n',encoding='utf8')
        state={'status':'queued','job_id':jid,'provider':data['provider'],'engine_ready':False,'log_path':str(folder/'build.log')}
        save(folder,state)
        flags={'creationflags':subprocess.CREATE_NO_WINDOW|subprocess.DETACHED_PROCESS} if sys.platform=='win32' else {'start_new_session':True}
        with (folder/'worker.log').open('ab') as log:
            subprocess.Popen([sys.executable,str(HERE/'host_job.py'),'work',jid],stdin=subprocess.DEVNULL,stdout=log,stderr=log,**flags)
        return state
    except Exception:
        lock.unlink(missing_ok=True)
        if folder.is_dir() and (folder/'job.json').is_file():save(folder,{'status':'failed','job_id':jid,'error':'Debian build worker could not be started','engine_ready':False})
        raise ValueError('Debian build worker could not be started') from None


def work(jid):
    folder=job_folder(jid)
    state=json.loads((folder/'job.json').read_text(encoding='utf8'))
    def update(status,**extra):
        state.update(status=status,**extra);save(folder,state)
    lock=jobs()/'active.lock'
    build_key=folder/'build-key'
    try:
        if lock.read_text(encoding='utf8')!=jid:
            raise ValueError('Debian VM job reservation is missing')
        request=check_request(json.loads((folder/'request.json').read_text(encoding='utf8')))
        tools=assert_host(request)
        update('building',stage='verifying_iso')
        if digest(Path(request['isoPath']))!=request['isoSha256']:
            raise ValueError('Local ISO SHA-256 does not match; nothing was built')
        deploy_key=folder/'deploy-key'
        profile_dir=folder/'packer'
        vagrant_dir=folder/'vagrant'
        with (folder/'build.log').open('wb') as log:
            def run(exe,argv,timeout,cwd=folder,env=None):
                subprocess.run([exe,*map(str,argv)],stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,
                               check=True,timeout=timeout,cwd=cwd,env=env)
            for file in (build_key,deploy_key):
                run(tools['ssh-keygen'],['-q','-t','ed25519','-N','','-f',file],20)
            def public(file):
                return ' '.join(file.with_suffix('.pub').read_text(encoding='ascii').split()[:2])
            rendered=render_profile(profile_dir,provider=request['provider'],iso_url=None,local_iso=request['isoPath'],
                                    iso_checksum='sha256:'+request['isoSha256'],build_public_key=public(build_key),
                                    ssh_private_key_file=build_key,deployment_public_key=public(deploy_key),
                                    build_name='vamp-podman-build-'+jid[:12])
            pkr=install();hcl=profile_dir/'podman.pkr.hcl';env=environment()
            update('building',stage='packer_init')
            run(pkr,['init',hcl],450,profile_dir,env)
            update('building',stage='packer_validate')
            run(pkr,['validate',hcl],180,profile_dir,env)
            update('building',stage='packer_build')
            run(pkr,['build','-color=false','-on-error=cleanup',hcl],7200,profile_dir,env)
            box=Path(rendered['box_path'])
            update('building',stage='auditing_private_box')
            metadata=box_metadata(box,rendered['provider'])
            box_sha256=digest(box)
            update('box_ready',stage='vagrant_prepare',box_created=True)
            vagrant_dir.mkdir(mode=0o700)
            name='vamp-podman-'+jid[:12]
            vagrantfile=render_vagrantfile(provider=rendered['provider'],metadata=metadata,box_path=str(box),
                                           box_sha256=box_sha256,private_key_path=str(deploy_key),name=name,memory_mb=4096)
            (vagrant_dir/'Vagrantfile').write_text(vagrantfile,encoding='utf8')
            vagrant_env={k:v for k,v in os.environ.items() if not k.upper().startswith('VAGRANT_')}
            vagrant_env.update(VAGRANT_CWD=str(vagrant_dir),VAGRANT_CHECKPOINT_DISABLE='1',VAGRANT_NO_COLOR='1')
            run(tools['vagrant'],['validate'],75,vagrant_dir,vagrant_env)
            update('deploying',stage='vagrant_up')
            run(tools['vagrant'],['up','--provider='+rendered['provider'],'--no-provision'],1800,vagrant_dir,vagrant_env)
            update('vm_started',stage='vagrant_up_completed',vm_name=name,engine_ready=False,
                   next_action='Independently verify SSH host key and rootless Podman socket before adding a named connection')
    except Exception as error:
        message=str(error) if isinstance(error,ValueError) else 'Debian VM build or deployment did not complete. Review the local job log.'
        update('failed',error=message,engine_ready=False)
    finally:
        build_key.unlink(missing_ok=True)
        build_key.with_suffix('.pub').unlink(missing_ok=True)
        if lock.is_file() and lock.read_text(encoding='utf8')==jid:lock.unlink()


def main():
    args=argparse.ArgumentParser()
    args.add_argument('action',choices=['start','status','work']);args.add_argument('id',nargs='?')
    options=args.parse_args()
    if options.action=='work':work(options.id);return
    if options.action=='status':
        result=json.loads((job_folder(options.id)/'job.json').read_text(encoding='utf8'))
    else:
        result=start(json.load(sys.stdin))
    print(json.dumps(result))


if __name__=='__main__':
    try:main()
    except (ValueError,OSError,subprocess.SubprocessError) as error:
        print(json.dumps({'status':'failed','error':str(error) if isinstance(error,ValueError) else 'Cannot access the Debian VM build on this host'}))
        sys.exit(1)
