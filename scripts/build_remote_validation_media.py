#!/usr/bin/env python3
"""Build bounded offline Windows lab media from previously verified installers."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile
import pycdlib
ROOT=Path(__file__).resolve().parents[1]


def build(directory, output):
    manifest=json.loads((Path(directory)/'manifest.json').read_text())
    files={}
    subset={name:manifest[name] for name in ('node','virtualbox','vboxsdk')}
    for name,info in subset.items():
        p=Path(info['path'])
        if hashlib.sha256(p.read_bytes()).hexdigest()!=info['sha256']:raise ValueError('Installer hash mismatch: '+name)
        files[p.name]=p.read_bytes()
    files['manifest.json']=json.dumps(subset).encode()
    files['Prepare.ps1']=(ROOT/'scripts/windows/prepare-remote-lab.ps1').read_bytes()
    files['Display.py']=(ROOT/'guest_setup/recorder/windows-display.py').read_bytes()
    bundle=io.BytesIO()
    with zipfile.ZipFile(bundle,'w',zipfile.ZIP_DEFLATED) as z:
        for folder in ('backends/remote_ssh','backends/library'):
            for p in (ROOT/folder).rglob('*'):
                if p.is_file() and '__pycache__' not in p.parts:z.write(p,p.relative_to(ROOT))
        for name in ('backends/virtualbox/mouse_click.py','backends/virtualbox/setup_windows_sdk.py','third_party/mcp-virtualbox/scripts/mouse_click.py','guest_keys.py','recording_converter.py'):
            z.write(ROOT/name,name)
    files['source.zip']=bundle.getvalue()
    target=Path(output).resolve()
    if target.exists():raise ValueError('Choose a new ISO path')
    iso=pycdlib.PyCdlib();iso.new(interchange_level=3,joliet=3,vol_ident='VAMP_REMOTE_LAB');streams=[]
    try:
        for i,(name,data) in enumerate(files.items()):
            stream=io.BytesIO(data);streams.append(stream);iso.add_fp(stream,len(data),iso_path=f'/F{i:04}.DAT;1',joliet_path='/'+name)
        iso.write(str(target))
    finally:iso.close()
    return {'iso':str(target),'files':list(files)}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--installers',required=True);p.add_argument('--output',required=True);a=p.parse_args();print(json.dumps(build(a.installers,a.output),indent=2))
