"""Shared asynchronous Packer orchestration for VSIX and MCP."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import threading
import uuid

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
ASSETS=Path(os.environ.get('VAMP_PROVISIONING_ASSETS') or ROOT)
sys.path[:0]=[str(HERE),str(ROOT/'backends/common'),str(ASSETS/'scripts')]
from toolchain import home,init,environment,executable,POLICY
from guest_install import require_install_host,post_create_notice
from templates import render
from images import list_images,delete,directory

def write(path,data):
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(data,indent=2)+'\n');temp.replace(path)

def run(exe,args,timeout=120,*,binary=False,**kwargs):
    return subprocess.run([str(exe),*map(str,args)],capture_output=True,text=not binary,timeout=timeout,check=True,**kwargs).stdout


def hyperv_json(query, stage):
    command = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; " + query
    try:
        output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], timeout=30, binary=True)
    except subprocess.CalledProcessError as error:
        detail = error.stderr or error.stdout or b''
        if isinstance(detail, bytes):
            detail = detail.decode('utf-8', errors='replace')
        lines = detail.strip().splitlines()
        message = lines[0][:240] if lines else 'Check Hyper-V permissions in this Windows session.'
        raise RuntimeError(f'Hyper-V {stage} failed (exit {error.returncode}): {message}') from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'Hyper-V {stage} timed out') from None
    if output is None:
        raise RuntimeError(f'Hyper-V {stage} returned no stdout')
    if not output.strip():
        raise RuntimeError(f'Hyper-V {stage} returned empty stdout')
    try:
        return json.loads(output)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeError(f'Hyper-V {stage} returned invalid JSON') from None

def vbox():
    return os.environ.get('VBOXMANAGE_PATH') or (str(Path(os.environ.get('ProgramFiles','C:/Program Files'))/'Oracle/VirtualBox/VBoxManage.exe') if sys.platform=='win32' else 'VBoxManage')

def check_request(request):
    request=dict(request);backend=request.get('backend','virtualbox');request['backend']=backend
    require_install_host(backend)
    request.setdefault('guest_os','debian');guest=request['guest_os']
    if guest not in ('debian','windows11'):raise ValueError('Packer profiles currently require a Debian amd64 installer ISO or Windows 11 x64 ISO')
    if request.get('installation_mode','auto') not in ('auto','unattended'):raise ValueError('Packer owns unattended installation; manual mode is no longer a Packer profile')
    if request.get('product_key') and not re.fullmatch(r'[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4}',request['product_key']):raise ValueError('Invalid Windows product key format')
    name=request.get('name') or 'VAMP-'+uuid.uuid4().hex[:8];request['name']=name
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,62}',name):raise ValueError('Invalid VM name')
    iso=Path(request['iso_path']).expanduser().resolve(strict=True)
    if not iso.is_file():raise ValueError('Choose a readable local ISO')
    request['iso_path']=str(iso)
    for key,default,low,high in [('memory_mb',4096 if guest=='windows11' else 2048,4096 if guest=='windows11' else 2048,131072),('cpus',2,1,64),('disk_mb',65536,32768,2097152),('image_index',1,1,99)]:
        if request.get(key) is None:request[key]=default
        if type(request[key]) is not int or not low<=request[key]<=high:raise ValueError('Invalid '+key)
    if backend=='hyperv':
        from hyperv_bootstrap import requested_host
        selected=requested_host(request,os.environ)
        if selected is not None:request['bootstrap_host']=selected
    if backend=='kvm':
        from kvm_bootstrap import resolve_kvm_bootstrap_host,kvm_bind_address
        request['bootstrap_host']=resolve_kvm_bootstrap_host(request)
        kvm_bind_address(request['bootstrap_host'])
    return request

def conflicts(backend):
    if not sys.platform.startswith('linux'):return
    if backend=='kvm':
        try:
            if run(vbox(),['list','runningvms']).strip():raise ValueError('A VirtualBox VM is active; shut it down before starting KVM')
        except FileNotFoundError:pass
    if backend=='virtualbox':
        for uri in ['qemu:///session','qemu:///system']:
            try:
                if run('virsh',['-c',uri,'list','--name']).strip():raise ValueError('A KVM VM is active; shut it down before starting VirtualBox')
            except (FileNotFoundError,subprocess.CalledProcessError):pass

def names(backend,request):
    if backend=='virtualbox':return [m[1] for m in re.finditer(r'^"(.*)" \{',run(vbox(),['list','vms']),re.M)]
    if backend=='kvm':return run('virsh',['-c',request.get('libvirt_uri','qemu:///session'),'list','--all','--name']).splitlines()
    inventory = hyperv_json('ConvertTo-Json -InputObject @(Get-VM | Select-Object -ExpandProperty Name) -Compress', 'VM inventory')
    if not isinstance(inventory, list) or any(not isinstance(name, str) for name in inventory):
        raise RuntimeError('Hyper-V VM inventory returned an invalid name list')
    return inventory

def hyperv_network(request):
    from hyperv_bootstrap import NETWORK_QUERY, select_network
    switch=request.get('switch_name','Default Switch')
    if not isinstance(switch,str) or not re.fullmatch(r'[^\x00-\x1f\x7f]{1,128}',switch) or switch.startswith('-'):
        raise ValueError('Choose a valid Hyper-V switch name')
    data = hyperv_json(NETWORK_QUERY, 'switch IPv4 check')
    return select_network(data,switch,request.get('bootstrap_host'))

def create(request):
    request=check_request(request)
    preflight={}
    if request['backend']=='hyperv' and (request.get('preflight_only') or request['guest_os']!='windows11' or request.get('windows_confirmed')):
        from hyperv_bootstrap import require_deployment_policy
        network=hyperv_network(request)
        request['bootstrap_host']=network['host_ipv4']
        preflight={'windows_execution_policy':network['execution_policy'],'deployment_blocked':network['execution_policy']=='Restricted'}
        if not request.get('preflight_only'):require_deployment_policy(network)
    if request.get('preflight_only'):return {'status':'preflight_ready','engine':'packer','vm_created':False,'request':request,'post_reboot_wait_seconds':60,**preflight}
    if request['guest_os']=='windows11' and not request.get('windows_confirmed'):
        return {'status':'needs_windows_confirmation','vm_created':False,'action_required':'Windows requires explicit confirmation and your own valid license.'}
    conflicts(request['backend'])
    if request['name'] in names(request['backend'],request):raise ValueError('VM name already exists; refusing to replace it')
    live=home()/'vms'/request['backend']/request['name']
    if live.exists():raise ValueError('VM storage path already exists; refusing to replace it')
    image_id=uuid.uuid4().hex;folder=directory(image_id)
    locks=home()/'locks';locks.mkdir(parents=True,exist_ok=True)
    lock=locks/(request['backend']+'-'+request['name']+'.lock')
    try:
        with lock.open('x') as file:file.write(image_id)
    except FileExistsError:raise ValueError('A build already reserves this VM name. Finish it or delete its failed golden image first.')
    folder.mkdir(parents=True)
    record={'id':image_id,'name':request['name'],'backend':request['backend'],'guest_os':request['guest_os'],'status':'queued','engine':'HashiCorp Packer','installation_verified':False,'post_reboot_wait_seconds':60}
    write(folder/'image.json',record);write(folder/'request.json',request)
    flags={'creationflags':subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS} if sys.platform=='win32' else {'start_new_session':True}
    try:
        with (folder/'worker.log').open('ab') as output:
            child=subprocess.Popen([sys.executable,str(HERE/'runner.py'),'worker','--id',image_id],stdin=subprocess.DEVNULL,stdout=output,stderr=output,**flags)
    except Exception as exc:
        record.update(status='failed',error=str(exc));write(folder/'image.json',record);lock.unlink(missing_ok=True);raise
    notice=post_create_notice(request['guest_os'],f"http://{request.get('bootstrap_host','10.0.2.2')}:8421")
    notice['title']='Packer build queued: OS installation and post-install setup'
    notice['message']='HashiCorp Packer downloads its CLI and official plugin, installs the guest, waits 60 seconds after the first reboot and completes post-install setup. Windows also installs the hypervisor guest drivers and reboots before completion. Debian uses automatic desktop login. Check Golden images for status, paths and logs. The live VM is deployed only after the build succeeds.'
    if request['backend'] in ('hyperv','kvm'):
        notice['setup_command']=''
        notice['message']+=f" Build-only bootstrap IPv4: {request['bootstrap_host']}. If guest setup fails, check the build logs and correct connectivity before building again."
    return {'status':'installation_started','engine':'packer','installation_mode':'unattended','installation_verified':False,'image_id':image_id,'worker_pid':child.pid,
            'vm':request['name'],'golden_image_path':str(folder),'log_path':str(folder/'packer.log'),
            'post_reboot_wait_seconds':60,'credentials':{'username':'vboxuser','password':'password123!','public_sandbox_credentials':True},
            'post_create_notice':notice,
            'next_action':'Read golden image status. Packer builds and verifies guest setup, then exports a golden image and deploys a separate live VM disk.'}

def deploy(request,folder):
    backend=request['backend'];name=request['name'];live=home()/'vms'/backend/name
    live.mkdir(parents=True,exist_ok=False);artifact=folder/'artifact'
    if backend=='virtualbox':
        ova=next(artifact.glob('*.ova'))
        run(vbox(),['import',ova,'--vsys','0','--vmname',name,'--basefolder',live],timeout=1800)
        info=run(vbox(),['showvminfo',name,'--machinereadable'])
        vm_id=re.search(r'^UUID="([^"]+)"',info,re.M)[1]
        cfg=Path(re.search(r'^CfgFile="([^"]+)"',info,re.M)[1]);journal={'status':'completed','installation_verified':True,'installation_mode':'packer','golden_image_id':folder.name}
        write(cfg.parent/'vamp-install.json',journal)
        run(vbox(),['startvm',name,'--type','headless'])
        state=run(vbox(),['showvminfo',name,'--machinereadable'])
        if not re.search(r'^VMState="running"',state,re.M):raise RuntimeError('Deployed VM did not reach Running state')
    elif backend=='kvm':
        uri=request.get('libvirt_uri','qemu:///session')
        profile=request['osinfo'];volume=None
        if uri.endswith('/system'):
            volume='vamp-'+name+'.qcow2'
            run('virsh',['-c',uri,'pool-info','default'])
            run('virsh',['-c',uri,'vol-create-as','default',volume,str(request['disk_mb'])+'MiB','--format','qcow2'])
            disk=Path(run('virsh',['-c',uri,'vol-path','--pool','default',volume]).strip())
            write(live/'deployment.json',{'volume':volume,'pool':'default','disk':str(disk),'status':'uploading'})
            run('virsh',['-c',uri,'vol-upload','--pool','default',volume,artifact/'golden.qcow2','--sparse'],timeout=1800)
            disk_spec='vol=default/'+volume+',format=qcow2,bus='+profile['disk_bus']
            network='network=default,model='+profile['nic']
        else:
            disk=live/'disk.qcow2'
            run('qemu-img',['convert','-O','qcow2',artifact/'golden.qcow2',disk],timeout=1800)
            disk_spec=f'path={disk},format=qcow2,bus='+profile['disk_bus'];network='user,model='+profile['nic']
        args=['--connect',uri,'--name',name,'--memory',request['memory_mb'],'--vcpus',request['cpus'],'--import','--disk',disk_spec,
              '--boot','uefi','--graphics','vnc,listen=127.0.0.1','--video',profile['video'],'--input','tablet,bus=usb','--network',network,'--osinfo','name='+profile['short_id'],'--noautoconsole']
        if request['guest_os']=='windows11':args+=['--tpm','backend.type=emulator,backend.version=2.0,model=tpm-crb']
        run('virt-install',args);vm_id=run('virsh',['-c',uri,'domuuid',name]).strip()
        if run('virsh',['-c',uri,'domstate',vm_id]).strip()!='running':raise RuntimeError('Deployed VM did not reach Running state')
    else:
        assets=Path(os.environ.get('VAMP_PROVISIONING_ASSETS') or ROOT)
        vm_id=run('powershell.exe',['-NoProfile','-NonInteractive','-File',assets/'backends/packer/deploy-hyperv.ps1','-Artifact',artifact,'-Destination',live,'-Name',name],timeout=1800).strip()
    ownership={'id':vm_id,'name':name,'folder':str(live),'guest_os':request['guest_os'],'golden_image_id':folder.name}
    if backend=='kvm':ownership.update(disk=str(disk),volume=volume,pool='default' if volume else None)
    write(live/'vamp-ui.json',ownership)
    return {'vm_id':vm_id,'vm_path':str(live),'vm_disk_path':str(disk) if backend=='kvm' else str(live),'vm':name,'startup_verified':True}

def worker(image_id):
    folder=directory(image_id);record=json.loads((folder/'image.json').read_text());request=json.loads((folder/'request.json').read_text());server=None;bootstrap_server=None
    record_lock=threading.Lock()
    def update(**fields):
        with record_lock:
            record.update(**fields)
            write(folder/'image.json',record)
    def status(value,**extra):
        update(status=value,**extra)
    try:
        status('building',worker_pid=os.getpid())
        conflicts(request['backend'])
        token=secrets.token_hex(32);completed=threading.Event()
        observe_preseed=request['backend']=='hyperv' and request['guest_os']=='debian'
        if observe_preseed:
            update(installer_preseed_received=False)
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if not observe_preseed or self.path!='/preseed/'+token:
                    self.send_error(404);return
                data=(folder/'http/preseed.cfg').read_bytes()
                if self.client_address[0]!=host:
                    update(installer_preseed_received=True)
                self.send_response(200)
                self.send_header('Content-Type','text/plain; charset=utf-8')
                self.send_header('Content-Length',str(len(data)))
                self.send_header('Cache-Control','no-store')
                self.end_headers()
                self.wfile.write(data)
            def do_POST(self):
                if self.path!='/complete/'+token:self.send_error(404);return
                update(guest_setup_completed=True,stage='golden_export');completed.set();self.send_response(200);self.end_headers();self.wfile.write(b'OK')
            def log_message(self,*args):pass
        host='10.0.2.2'
        if request['backend']=='hyperv':
            from hyperv_bootstrap import require_deployment_policy
            network=hyperv_network(request)
            require_deployment_policy(network)
            host=network['host_ipv4'];status('building',network=network)
        if request['backend']=='kvm':
            from kvm_bootstrap import resolve_kvm_bootstrap_host,bind_kvm_listener
            host=resolve_kvm_bootstrap_host(request)
            # Fail closed before osinfo, libvirt or Packer preparation. The guest
            # alias maps to host loopback; overrides must be assigned locally.
            server=bind_kvm_listener(host,0,lambda bind,port:ThreadingHTTPServer((bind,port),Handler))
            threading.Thread(target=server.serve_forever,daemon=True).start()
            from script_server import stage,make_server
            staged=stage(destination=folder/'bootstrap',port=8421)
            bootstrap_server=bind_kvm_listener(host,8421,lambda bind,port:make_server(Path(staged['directory']),port,bind,10800))
            threading.Thread(target=bootstrap_server.serve_forever,daemon=True).start()
            from osinfo import resolve
            profile=resolve(request,folder)
            if profile['libvirt_uri'].endswith('/system'):
                uri=profile['libvirt_uri']
                run('virsh',['-c',uri,'net-info','default']);run('virsh',['-c',uri,'pool-info','default'])
                if 'default' not in run('virsh',['-c',uri,'net-list','--name']).splitlines():run('virsh',['-c',uri,'net-start','default'])
                if 'default' not in run('virsh',['-c',uri,'pool-list','--name']).splitlines():run('virsh',['-c',uri,'pool-start','default'])
            status('building',osinfo_profile=profile,resource_profile={key:request[key] for key in ['memory_mb','cpus','disk_mb']})
        if request['backend']!='kvm':
            server=ThreadingHTTPServer((host if request['backend']=='hyperv' else '0.0.0.0',0),Handler)
            threading.Thread(target=server.serve_forever,daemon=True).start()
        if request['backend']=='hyperv':
            # Job-owned listener: no reuse of an unrelated adapter or wildcard.
            # Binding is atomic; port conflicts fail instead of changing hosts.
            from script_server import stage,make_server
            staged=stage(destination=folder/'bootstrap',port=8421)
            bootstrap_server=make_server(Path(staged['directory']),8421,host,10800)
            threading.Thread(target=bootstrap_server.serve_forever,daemon=True).start()
        elif request['backend']!='kvm':
            from script_server import start
            started=start(port=8421,ttl=10800)
            if started.get('status')!='running':raise RuntimeError('Guest setup script server failed to start')
        if request['backend'] in ('hyperv','kvm'):status('building',bootstrap_host=host,bootstrap_port=8421)
        callback=f'http://{host}:{server.server_port}/complete/{token}'
        with Path(request['iso_path']).open('rb') as file:iso_hash=hashlib.file_digest(file,'sha256').hexdigest()
        from drivers import prepare as prepare_drivers
        driver_iso=prepare_drivers(request,vbox(),run)
        if driver_iso:status('building',driver_media=str(driver_iso))
        if request['backend']=='hyperv':
            (folder/'temporary').mkdir(exist_ok=True)
        template=render(request,folder,iso_hash,f'http://{host}:8421',callback)
        with (folder/'packer.log').open('w',encoding='utf8') as log:
            # Init a separate directory so duplicate required_plugins blocks never coexist.
            init(request['backend'],home()/'tools/packer/init'/request['backend'],log)
            for args in [['validate',str(template)],['build','-color=false','-on-error=abort',str(template)]]:
                subprocess.run([str(executable()),*args],env=environment(),stdout=log,stderr=subprocess.STDOUT,timeout=10800,check=True)
        if not completed.is_set():raise RuntimeError('Packer exited without the authenticated guest post-install completion signal')
        status('deploying',installation_verified=True,artifact_path=str(folder/'artifact'))
        result=deploy(request,folder)
        status('completed',**result)
    except Exception as exc:
        if record.get('installer_preseed_received') is False and (folder/'packer.log').is_file():
            update(installer_hint='No guest preseed request was observed. Check the installer network screen and the selected Hyper-V switch.')
        status('failed',error=str(exc),partial_files_preserved=True)
    finally:
        if bootstrap_server:bootstrap_server.shutdown();bootstrap_server.server_close()
        if server:server.shutdown();server.server_close()
        lock=home()/'locks'/(request['backend']+'-'+request['name']+'.lock')
        if lock.exists() and lock.read_text()==image_id:lock.unlink()

def delete_image(image_id,confirmed=False):
    folder=directory(image_id);record=json.loads((folder/'image.json').read_text());backend=record.get('backend')
    build_name='VAMP-build-'+image_id[:12]
    if backend in ('virtualbox','hyperv') and build_name in names(backend,{}):
        raise ValueError('A partial build VM is still registered: '+build_name+'. Shut it down and remove it in VM Manager before deleting the golden files.')
    if backend=='kvm' and sys.platform.startswith('linux'):
        for process in Path('/proc').iterdir():
            if not process.name.isdigit():continue
            try:
                command=(process/'cmdline').read_bytes()
                if b'qemu-system' in command and str(folder).encode() in command:raise ValueError('A QEMU build still uses this image; stop that build before deleting it')
            except (PermissionError,FileNotFoundError,ProcessLookupError):pass
    result=delete(image_id,confirmed)
    if result['status']=='deleted' and backend and record.get('name'):
        lock=home()/'locks'/(backend+'-'+record['name']+'.lock')
        if lock.exists() and lock.read_text()==image_id:lock.unlink()
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['prepare','check','create','worker','images','delete-image']);parser.add_argument('--backend',default='virtualbox');parser.add_argument('--id');parser.add_argument('--confirmed',action='store_true');args=parser.parse_args()
    if args.action=='worker':worker(args.id);return
    if args.action=='prepare':result=init(args.backend,home()/'tools/packer/init'/args.backend)
    elif args.action=='check':result={'status':'ready' if executable().is_file() else 'missing','executable':str(executable()),'engine':'packer'}
    elif args.action=='create':result=create(json.load(sys.stdin))
    elif args.action=='images':result={'images':list_images(),'storage':str(home())}
    else:result=delete_image(args.id,args.confirmed)
    print(json.dumps(result))

if __name__=='__main__':
    try:main()
    except Exception as exc:print(json.dumps({'status':'failed','error':str(exc)}));sys.exit(1)
