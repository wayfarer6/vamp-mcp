#!/usr/bin/env python3
"""Windows-only Hyper-V/VMConnect launcher with ordinary UAC elevation."""
import argparse
import base64
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROBOT_AUTO_KEYWORDS=False


def build_command(vm_name,server,start_vm,result_path):
    if not vm_name.strip() or any(ord(c)<32 for c in vm_name+server):
        raise ValueError('VM name and server must be nonempty printable strings')
    request={'vm_name':vm_name,'server':server,'start_vm':bool(start_vm),'result_path':str(result_path)}
    payload=base64.b64encode(json.dumps(request,ensure_ascii=False).encode()).decode()
    script=Path(__file__).with_name('Open-HyperVConsole.ps1').read_text(encoding='utf-8')
    # Base64 transports Unicode and quotes without interpreting VM names as PowerShell code.
    command='& {\n'+script+'\n} -RequestBase64 \''+payload+'\''
    encoded=base64.b64encode(command.encode('utf-16le')).decode()
    return ['-NoLogo','-NoProfile','-EncodedCommand',encoded]


def open_console(vm_name,server='localhost',start_vm=False,output=None,timeout=180):
    if sys.platform!='win32':
        raise RuntimeError('Hyper-V VMConnect launcher runs on a Windows host; no Windows action was executed')
    start_vm=str(start_vm).lower() in ('true','1','yes','on')
    result_path=Path(output or 'artifacts/hyperv/console-result.json').resolve()
    result_path.parent.mkdir(parents=True,exist_ok=True);result_path.unlink(missing_ok=True)
    args=build_command(vm_name,server,start_vm,result_path)
    powershell=Path(os.environ.get('WINDIR',r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
    if not powershell.is_file():raise FileNotFoundError('Windows PowerShell was not found')
    shell=ctypes.windll.shell32
    shell.ShellExecuteW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_wchar_p,
                                 ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_int]
    shell.ShellExecuteW.restype=ctypes.c_ssize_t
    admin=bool(shell.IsUserAnAdmin())
    code=shell.ShellExecuteW(None,'open' if admin else 'runas',str(powershell),
                             subprocess.list2cmdline(args),str(result_path.parent),1)
    if code<=32:
        return {'status':'elevation_or_launch_rejected','backend':'hyperv',
                'shell_code':int(code),'guest_connection_verified':False}
    deadline=time.monotonic()+float(timeout)
    while time.monotonic()<deadline:
        if result_path.is_file():
            try:return json.loads(result_path.read_text(encoding='utf-8-sig'))
            except (ValueError,OSError):pass  # worker may still be writing the short result
        time.sleep(.2)
    return {'status':'launch_unverified','backend':'hyperv','guest_connection_verified':False,
            'error_summary':'No elevated worker result before timeout; inspect UAC/VMConnect.',
            'details_path':str(result_path)}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--vm',required=True)
    parser.add_argument('--server',default='localhost')
    parser.add_argument('--start-vm',action='store_true')
    parser.add_argument('--output',default='artifacts/hyperv/console-result.json')
    parser.add_argument('--timeout',type=float,default=180)
    args=parser.parse_args()
    result=open_console(args.vm,args.server,args.start_vm,args.output,args.timeout)
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0 if result['status']=='launch_requested' else 1


if __name__=='__main__':raise SystemExit(main())
