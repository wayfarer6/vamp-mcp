"""Probe/install ONLY the open-source VNC extension and configure a loopback console."""
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile
import xml.etree.ElementTree as ET
try:
    from .display import command
    from .provision import parse
except ImportError:
    from display import command
    from provision import parse

SOURCE='https://www.virtualbox.org/browser/vbox/trunk/src/VBox/ExtPacks/VNC'


def probe(run=command):
    version=run('--version').strip();text=run('list','extpacks')
    blocks=re.split(r'(?m)^Pack no\.\s*\d+:',text)[1:]
    vnc=next((block for block in blocks if block.splitlines()[0].strip()=='VNC'),None)
    usable=bool(vnc and re.search(r'(?m)^Usable:\s*true\s*$',vnc,re.I))
    return {'status':'available' if usable else 'module_required','backend':'virtualbox','protocol':'vnc',
            'virtualbox_version':version,'open_source_module':'VNC','module_usable':usable,
            'oracle_extension_pack_required':False,'source':SOURCE}


def setup(vm=None,extpack_path=None,sha256=None,allow_install=False,port=5901,run=command):
    state=probe(run)
    if not state['module_usable'] and extpack_path:
        if not allow_install:return {**state,'status':'install_not_requested'}
        source=Path(extpack_path).expanduser().resolve(strict=True)
        if not sha256 or hashlib.file_digest(source.open('rb'),'sha256').hexdigest().casefold()!=sha256.casefold():
            raise ValueError('Provide the verified SHA-256 of the chosen VNC extension package')
        with tarfile.open(source,'r:*') as archive:
            metadata=next((member for member in archive.getmembers() if member.name=='ExtPack.xml'),None)
            if metadata is None or metadata.size>65536:raise ValueError('Invalid extension package metadata')
            root=ET.fromstring(archive.extractfile(metadata).read())
        if root.findtext('Name')!='VNC':raise ValueError('Only the open-source VNC extension is accepted; Oracle Extension Pack is not installed')
        version=root.find('Version')
        package_version=(version.text or '').strip() if version is not None else ''
        host_version=state['virtualbox_version'].split('_')[0].split('r')[0]
        if package_version!=host_version:raise ValueError('VNC extension version must match the host VirtualBox version')
        run('extpack','install','--replace',str(source))
        state=probe(run)
    if not vm or not state['module_usable']:return state
    if not 1024<=int(port)<=65535:raise ValueError('Use an unprivileged VNC port in 1024..65535')
    info=parse(run('showvminfo',vm,'--machinereadable'))
    if info.get('VMState') not in ('poweroff','aborted'):
        raise ValueError('Configure the VNC module on a powered-off VM before starting it')
    # Per-VM selection does not change another VM's host-global VRDE module.
    run('modifyvm',vm,'--vrdeextpack','VNC','--vrde','on','--vrdeaddress','127.0.0.1','--vrdeport',str(port))
    return {**state,'status':'configured','vm_name':vm,'host':'127.0.0.1','port':int(port),
            'uri':f'vnc://127.0.0.1:{port}','stream_verified':False}

if __name__=='__main__':
    try:
        values=json.load(sys.stdin);action=values.pop('action','probe')
        print(json.dumps(probe() if action=='probe' else setup(**values)))
    except Exception as error:print(json.dumps({'status':'error','error_summary':str(error)[:300]}));sys.exit(1)
