#!/usr/bin/env python3
"""Build offline guest installer media; never executes the guest recorder."""
from pathlib import Path
import argparse
import io
import json
import os
import zipfile

ROOT = Path(__file__).resolve().parents[1]

def build(output=None):
    import pycdlib
    assets = Path(os.environ.get('VAMP_PROVISIONING_ASSETS') or ROOT)
    destination = Path(output or ROOT/'artifacts/recorder-setup.iso').resolve()
    destination.parent.mkdir(parents=True,exist_ok=True)
    payload = io.BytesIO()
    with zipfile.ZipFile(payload,'w',zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((assets/'third_party/pyautogui-recorder').rglob('*')):
            if path.is_file():
                archive.write(path,str(path.relative_to(assets/'third_party/pyautogui-recorder')))
    files = {'recorder.zip':payload.getvalue()}
    files.update({p.name:p.read_bytes() for p in (assets/'guest_setup/recorder').iterdir() if p.is_file()})
    iso = pycdlib.PyCdlib()
    iso.new(interchange_level=3,joliet=3,vol_ident='RPA_RECORDER')
    buffers=[]
    try:
        for index,(name,content) in enumerate(sorted(files.items())):
            stream=io.BytesIO(content);buffers.append(stream)
            iso.add_fp(stream,len(content),iso_path=f'/FILE{index:03d}.DAT;1',joliet_path='/'+name)
        iso.write(str(destination))
    finally: iso.close()
    return {'status':'media_built','iso':str(destination),'guest_setup_completed':False,
            'guest_installers':{'windows11':'setup-win.cmd','debian':'setup.sh'},
            'recorder_license':'GPL-3.0','recording_started':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output')
    args=parser.parse_args()
    print(json.dumps(build(args.output)))
