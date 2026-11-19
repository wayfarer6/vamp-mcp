"""Managed, checksum-pinned Packer CLI and isolated official plugin installation."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
import venv

POLICY=json.loads(Path(__file__).with_name('policy.json').read_text())

def home():
    return Path(os.environ.get('VAMP_HOME',str(Path.home()/'.vamp'))).expanduser().resolve()

def distribution(system=None,machine=None):
    system=system or sys.platform
    system={'win32':'windows','darwin':'darwin','linux':'linux'}.get(system,system)
    machine=machine or platform.machine()
    arch={'AMD64':'amd64','x86_64':'amd64','x64':'amd64','aarch64':'arm64','ARM64':'arm64'}.get(machine,machine)
    key=system+'_'+arch
    if key not in POLICY['checksums']:raise ValueError('No pinned Packer binary for '+key)
    return key

def executable():
    return home()/'tools/packer'/POLICY['version']/distribution()/('packer.exe' if sys.platform=='win32' else 'packer')

def environment():
    env={**os.environ,'PACKER_PLUGIN_PATH':str(home()/'tools/packer/plugins'),
         'PACKER_CACHE_DIR':str(home()/'tools/packer/cache'),'CHECKPOINT_DISABLE':'1'}
    if os.environ.get('VBOXMANAGE_PATH'):
        env['PATH']=str(Path(os.environ['VBOXMANAGE_PATH']).parent)+os.pathsep+env.get('PATH','')
    return env

def install():
    target=executable()
    if target.is_file():
        result=subprocess.run([str(target),'version'],capture_output=True,text=True,timeout=20,check=True,creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if POLICY['version'] not in result.stdout:raise RuntimeError('Managed Packer version mismatch')
        return str(target)
    key=distribution();version=POLICY['version']
    url=f'https://releases.hashicorp.com/packer/{version}/packer_{version}_{key}.zip'
    target.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as directory:
        archive=Path(directory)/'packer.zip'
        with urllib.request.urlopen(url,timeout=120) as response,archive.open('wb') as output:
            import shutil
            shutil.copyfileobj(response,output)
        if hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()!=POLICY['checksums'][key]:
            raise RuntimeError('Packer archive SHA-256 mismatch; refusing to execute it')
        with zipfile.ZipFile(archive) as bundle:
            data=bundle.read(target.name)
        candidate=Path(directory)/target.name;candidate.write_bytes(data);candidate.chmod(0o755)
        candidate.replace(target)
    return str(target)

def init(backend,directory,log=None):
    plugin=POLICY['plugins'][backend]
    template=Path(directory)/'plugins.pkr.hcl'
    template.parent.mkdir(parents=True,exist_ok=True)
    template.write_text('packer {\n required_plugins {\n '+backend+' = {\n source = '+json.dumps(plugin['source'])+'\n version = '+json.dumps('= '+plugin['version'])+'\n }\n }\n}\n')
    subprocess.run([install(),'init',str(template)],env=environment(),stdout=log or sys.stderr,stderr=subprocess.STDOUT,timeout=300,check=True,creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return {'status':'ready','engine':'HashiCorp Packer','version':POLICY['version'],'executable':str(executable()),
            'plugin':plugin,'storage':str(home()),'notice':'VAMP uses HashiCorp Packer and downloads its CLI and the selected official hypervisor plugin. Hypervisor software is installed separately.'}

def answer_iso(answer,target,script,driver_iso=None):
    """The media helper is isolated from the user's system Python packages."""
    folder=home()/'tools/packer/answer-media'
    python=folder/('Scripts/python.exe' if sys.platform=='win32' else 'bin/python')
    marker=folder/'pycdlib-1.14.0.ready'
    if not marker.is_file():
        if not python.is_file():venv.EnvBuilder(with_pip=True).create(folder)
        subprocess.run([str(python),'-m','pip','install','--disable-pip-version-check','pycdlib==1.14.0'],stdout=sys.stderr,stderr=subprocess.STDOUT,timeout=300,check=True,creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        marker.touch()
    args=[str(python),str(Path(__file__).with_name('answer_media.py')),str(answer),str(target),str(script)]
    if driver_iso:args.append(str(driver_iso))
    subprocess.run(args,timeout=300,check=True,creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
