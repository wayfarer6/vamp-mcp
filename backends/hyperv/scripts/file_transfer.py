"""Native Hyper-V bidirectional transfer through PowerShell Direct and private credentials."""
import base64
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def transfer(vm_name,direction,local_path,guest_path,overwrite=False,prompt_credentials=False,output=None,timeout=300):
    if sys.platform!='win32':return {'status':'unsupported_host','backend':'hyperv','error_summary':'Run on the Windows Hyper-V host'}
    if not vm_name.strip() or direction not in ('put','get'):raise ValueError('Provide an exact VM name and put/get direction')
    if not guest_path or any(p=='..' for p in guest_path.replace('\\','/').split('/')):raise ValueError('Use a relative guest exchange path')
    result_path=Path(output or Path('artifacts/hyperv')/('transfer-'+uuid.uuid4().hex+'.json')).resolve()
    result_path.parent.mkdir(parents=True,exist_ok=True);result_path.unlink(missing_ok=True)
    request={'vm_name':vm_name,'direction':direction,'local_path':str(Path(local_path).expanduser().resolve()),
             'guest_path':guest_path,'overwrite':bool(overwrite),'prompt_credentials':bool(prompt_credentials),'result_path':str(result_path)}
    payload=base64.b64encode(json.dumps(request,ensure_ascii=False).encode()).decode()
    script=Path(__file__).with_name('Transfer-HyperVFile.ps1').read_text(encoding='utf-8')
    encoded=base64.b64encode(('& {\n'+script+"\n} -RequestBase64 '"+payload+"'").encode('utf-16le')).decode()
    powershell=Path(os.environ.get('WINDIR',r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
    shell=ctypes.windll.shell32
    shell.ShellExecuteW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_int]
    shell.ShellExecuteW.restype=ctypes.c_ssize_t
    code=shell.ShellExecuteW(None,'open' if shell.IsUserAnAdmin() else 'runas',str(powershell),
                            subprocess.list2cmdline(['-NoLogo','-NoProfile','-EncodedCommand',encoded]),str(result_path.parent),1)
    if code<=32:return {'status':'elevation_or_launch_rejected','backend':'hyperv'}
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if result_path.is_file():return json.loads(result_path.read_text(encoding='utf-8-sig'))
        time.sleep(.2)
    return {'status':'transfer_unverified','backend':'hyperv','details_path':str(result_path)}

if __name__=='__main__':
    try:print(json.dumps(transfer(**json.load(sys.stdin))))
    except Exception as error:print(json.dumps({'status':'error','error_summary':str(error)[:300]}));sys.exit(1)
