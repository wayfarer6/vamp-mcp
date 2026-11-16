"""Install the matching Oracle VirtualBox Python SDK in a Windows host venv."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile

def setup(storage,vboxmanage=None,archive=None,sha256=None):
    if sys.platform!='win32':raise RuntimeError('The COM SDK setup is for Windows hosts')
    if sys.prefix==sys.base_prefix:raise RuntimeError('Run SDK setup with the isolated host Python venv')
    binary=Path(vboxmanage or shutil.which('VBoxManage') or r'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe')
    version=subprocess.check_output([str(binary),'--version'],text=True).strip()
    match=re.match(r'(\d+\.\d+\.\d+)r(\d+)',version)
    if not match:raise RuntimeError('Unrecognized installed VirtualBox version')
    release,revision=match.groups()
    destination=Path(storage).resolve()/('virtualbox-sdk-'+release+'-'+revision)
    destination.mkdir(parents=True,exist_ok=True)
    if archive:
        package=Path(archive)
        if not sha256:raise ValueError('An offline SDK archive requires its expected SHA-256')
        expected=sha256.lower()
    else:
        name=f'VirtualBoxSDK-{release}-{revision}.zip'
        base=f'https://download.virtualbox.org/virtualbox/{release}/'
        with urllib.request.urlopen(base+'SHA256SUMS',timeout=30) as response:
            lines=response.read(1024*1024).decode().splitlines()
        expected=next(line.split()[0].lower() for line in lines if line.split()[-1].lstrip('*')==name)
        package=destination/'sdk.zip'
        if not package.exists() or hashlib.file_digest(package.open('rb'),'sha256').hexdigest()!=expected:
            temporary=package.with_suffix('.part')
            with urllib.request.urlopen(base+name,timeout=120) as response,temporary.open('wb') as output:
                shutil.copyfileobj(response,output)
            temporary.replace(package)
    with package.open('rb') as stream:
        if hashlib.file_digest(stream,'sha256').hexdigest()!=expected:raise ValueError('VirtualBox SDK checksum mismatch')
    with zipfile.ZipFile(package) as source:
        for info in source.infolist():
            if not (destination/info.filename).resolve().is_relative_to(destination):raise ValueError('SDK archive path escapes extraction directory')
        source.extractall(destination)
    environment={**os.environ,'VBOX_MSI_INSTALL_PATH':str(binary.parent),'VBOX_VERSION':release}
    subprocess.run([sys.executable,'-m','pip','install','setuptools','pywin32'],check=True,timeout=180,stdout=sys.stderr)
    installer=destination/'sdk/installer/python/vboxapisetup.py'
    if not installer.is_file():raise RuntimeError('Matching SDK Python installer was not found')
    subprocess.run([sys.executable,str(installer),'install'],cwd=installer.parent,env=environment,check=True,timeout=180,stdout=sys.stderr)
    observed=subprocess.check_output([sys.executable,'-c','from vboxapi import VirtualBoxManager; m=VirtualBoxManager(None,None); print(m.getVirtualBox().version)'],env=environment,text=True).strip()
    if observed!=release:raise RuntimeError('SDK/COM reported a different VirtualBox version')
    return {'status':'installed','virtualbox_version':observed,'sdk_sha256':expected,'python':sys.executable,'sdk_path':str(destination)}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--storage',required=True);p.add_argument('--vboxmanage');p.add_argument('--archive');p.add_argument('--sha256');a=p.parse_args()
    try:print(json.dumps(setup(**vars(a))))
    except Exception as error:print(json.dumps({'status':'error','error_summary':str(error)}));sys.exit(1)
