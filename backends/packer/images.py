"""Inventory and deletion of VAMP-owned golden artifacts, separate from live disks."""
import json
import os
from pathlib import Path
import re
import shutil
import time
from toolchain import home

def directory(image_id):
    if not re.fullmatch(r'[a-f0-9]{32}',image_id):raise ValueError('Invalid golden image ID')
    root=home()/'golden';folder=root/image_id
    if root.is_symlink() or folder.is_symlink() or (hasattr(folder,'is_junction') and folder.is_junction()) or folder.resolve()!=root.resolve()/image_id:raise ValueError('Unsafe golden image path')
    return folder

def size(folder):
    total=0
    for root,dirs,files in os.walk(folder,followlinks=False):
        dirs[:]=[d for d in dirs if not (Path(root)/d).is_symlink()]
        for name in files:
            path=Path(root)/name
            if not path.is_symlink():total+=path.stat().st_size
    return total

def process_alive(pid):
    if os.name=='nt':
        import ctypes
        kernel=ctypes.windll.kernel32
        kernel.OpenProcess.restype=ctypes.c_void_p
        handle=kernel.OpenProcess(0x1000,False,int(pid))
        if not handle:return False
        code=ctypes.c_ulong()
        try:return bool(kernel.GetExitCodeProcess(ctypes.c_void_p(handle),ctypes.byref(code))) and code.value==259
        finally:kernel.CloseHandle(ctypes.c_void_p(handle))
    try:os.kill(int(pid),0);return True
    except ProcessLookupError:return False
    except PermissionError:return True

def current_record(folder):
    record=json.loads((folder/'image.json').read_text())
    if record['status'] in ('queued','building','deploying'):
        pid=record.get('worker_pid')
        if (pid and not process_alive(pid)) or (not pid and time.time()-(folder/'image.json').stat().st_mtime>60):
            record={**record,'status':'interrupted','error':'Build worker is no longer running; partial files were preserved.'}
    return record

def list_images():
    root=home()/'golden';rows=[]
    if not root.exists():return rows
    for folder in sorted(root.iterdir()):
        try:
            if folder.is_symlink():continue
            folder=directory(folder.name)
            record=current_record(folder)
            artifacts=[]
            for root,dirs,files in ([] if (folder/'artifact').is_symlink() else os.walk(folder/'artifact',followlinks=False)):
                dirs[:]=[d for d in dirs if not (Path(root)/d).is_symlink()]
                for name in files:
                    file=Path(root)/name
                    if file.suffix.lower() in ('.ova','.ovf','.vdi','.qcow2','.vhd','.vhdx','.vmcx') and not file.is_symlink():
                        artifacts.append({'path':str(file),'bytes':file.stat().st_size})
            rows.append({**record,'id':folder.name,'path':str(folder),'bytes':size(folder),'files':artifacts,
                         'log_path':str(folder/'packer.log')})
        except (OSError,ValueError):continue
    return rows

def delete(image_id,confirmed=False):
    folder=directory(image_id)
    record=current_record(folder)
    if record['status'] in ('queued','building','deploying'):raise ValueError('Wait for the Packer build to finish before deleting its files')
    amount=size(folder)
    if not confirmed:return {'status':'needs_confirmation','id':image_id,'path':str(folder),'bytes':amount,'live_vm_disks_deleted':False}
    # Only this known artifact root is removed; deployed VM disks live under vms/.
    shutil.rmtree(folder)
    return {'status':'deleted','id':image_id,'path':str(folder),'bytes_reclaimed':amount,'live_vm_disks_deleted':False}
