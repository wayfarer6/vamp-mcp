"""Read Ubuntu's osinfo-db and resolve virt-manager/virt-install hardware XML.

No vendor XML is bundled. Native libosinfo profiles and virt-install resolve
inheritance/device defaults; --dry-run --print-xml never creates a probe VM.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET

def database(roots=None):
    roots=roots or [Path('/usr/share/osinfo'),Path('/var/lib/osinfo'),Path('/etc/osinfo'),Path.home()/'.config/osinfo']
    if os.environ.get('VAMP_OSINFO_DB'):roots=[Path(os.environ['VAMP_OSINFO_DB'])]
    entries={}
    for root in roots:
        for file in sorted((Path(root)/'os').rglob('*.xml')):
            try:
                for node in ET.parse(file).getroot().findall('os'):
                    entries[node.attrib['id']]={'node':node,'file':str(file)}
            except (OSError,ET.ParseError,KeyError):continue
    if not entries:raise ValueError('Ubuntu KVM setup needs osinfo-db XML. Install osinfo-db, libosinfo-bin and virtinst, or set VAMP_OSINFO_DB.')
    return entries

def profile(guest,iso_path,entries=None,detect=None):
    entries=entries if entries is not None else database()
    detected={}
    if detect:
        detected=detect(iso_path)
    else:
        try:
            result=subprocess.run(['osinfo-detect','--type=media','--format=plain',str(iso_path)],env={**os.environ,'LC_ALL':'C'},capture_output=True,text=True,timeout=30,check=True)
            match=re.search(r"OS '(.+) \(([^()]+)\)'",result.stdout)
            if match:
                if match[2]!='x86_64':raise ValueError('The current Packer profile requires x86_64 installation media')
                for key,entry in entries.items():
                    names=[entry['node'].findtext('name'),*[variant.findtext('name') for variant in entry['node'].findall('variant')]]
                    if match[1] in names:detected={'OSINFO_OS_ID':key};break
        except (FileNotFoundError,subprocess.CalledProcessError):pass
    selected=entries.get(detected.get('OSINFO_OS_ID',''))
    distro='win' if guest=='windows11' else 'debian'
    if selected and selected['node'].findtext('distro')!=distro:raise ValueError('ISO detected by osinfo-db does not match the selected guest OS')
    fallback=False
    if not selected:
        candidates=[entry for entry in entries.values() if entry['node'].findtext('distro')==distro]
        if guest=='windows11':candidates=[entry for entry in candidates if entry['node'].findtext('short-id')=='win11']
        else:
            match=re.search(r'debian[-_ ]?(\d+)',Path(iso_path).name,re.I)
            if match:
                exact=[entry for entry in candidates if entry['node'].findtext('version')==match[1]]
                if exact:candidates=exact
                else:candidates=[entry for entry in candidates if float(entry['node'].findtext('version','0'))<=int(match[1])];fallback=True
        if not candidates:raise ValueError('No compatible '+guest+' profile in Ubuntu osinfo-db; update the host database')
        selected=max(candidates,key=lambda entry:tuple(int(value) for value in re.findall(r'\d+',entry['node'].findtext('version','0'))))
    node=selected['node'];short=node.findtext('short-id')
    if not short or not re.fullmatch(r'[A-Za-z0-9_.-]+',short):raise ValueError('Invalid osinfo short-id')
    minimum={};recommended={};visited=set()
    def resources(current):
        key=current.attrib['id']
        if key in visited:return
        visited.add(key)
        for parent in current.findall('derives-from'):
            if parent.attrib.get('id') in entries:resources(entries[parent.attrib['id']]['node'])
        for arch in ('all','x86_64'):
            for resource in current.findall('resources'):
                if resource.attrib.get('arch')!=arch:continue
                for target,kind in [(minimum,'minimum'),(recommended,'recommended')]:
                    for field in ['ram','storage','n-cpus']:
                        text=resource.findtext(kind+'/'+field)
                        if text and text.isdigit():target[field]=int(text)
    resources(node)
    return {'id':node.attrib['id'],'short_id':short,'name':node.findtext('name',short),'xml_path':selected['file'],
            'profile_fallback':fallback,'minimum':minimum,'recommended':recommended}

def resolve(request,folder,execute=None):
    execute=execute or (lambda args:subprocess.check_output(args,text=True,timeout=60))
    selected=profile(request['guest_os'],request['iso_path'])
    minimum=selected['minimum']
    request['memory_mb']=max(request['memory_mb'],(minimum.get('ram',0)+1048575)//1048576)
    request['disk_mb']=max(request['disk_mb'],(minimum.get('storage',0)+1048575)//1048576)
    request['cpus']=max(request['cpus'],minimum.get('n-cpus',1))
    uri=request.get('libvirt_uri','qemu:///session')
    if uri not in ('qemu:///session','qemu:///system'):raise ValueError('Packer KVM creation requires a local qemu:///session or qemu:///system URI')
    args=['virt-install','--connect',uri,'--name','VAMP-Profile-'+folder.name[:12],'--import','--memory',str(request['memory_mb']),'--vcpus',str(request['cpus']),
          '--disk','path='+str(folder/'profile-probe.qcow2')+',format=qcow2,size='+str(request['disk_mb']/1024),
          '--network','user','--graphics','vnc,listen=127.0.0.1','--boot','uefi','--osinfo','name='+selected['short_id'],'--dry-run','--print-xml']
    xml=execute(args);domain=ET.fromstring(xml)
    (folder/'virt-manager-profile.xml').write_text(xml)
    network=domain.find('devices/interface/model');disk=domain.find('devices/disk/target');kind=domain.find('os/type');video=domain.find('devices/video/model')
    loader=domain.find('os/loader');nvram=domain.find('os/nvram')
    # Modern libvirt can choose firmware using feature selectors rather than a
    # loader path. Packer's QEMU builder needs an explicit OVMF image instead.
    code=(loader.text or '').strip() if loader is not None else ''
    variables=nvram.attrib.get('template','') if nvram is not None else ''
    if not code:
        candidates=['/usr/share/OVMF/OVMF_CODE_4M.fd','/usr/share/OVMF/OVMF_CODE.fd']
        code=next((file for file in candidates if Path(file).is_file()),'')
    if not code:raise ValueError('Ubuntu OVMF firmware is missing; install ovmf')
    if not variables:variables=code.replace('CODE','VARS')
    if not Path(variables).is_file():raise ValueError('OVMF variables template is missing: '+variables)
    # Windows installation must use inbox SATA/e1000e drivers unless a separate
    # VirtIO driver payload has explicitly been provisioned.
    selected.update(machine=kind.attrib.get('machine','q35') if kind is not None else 'q35',
                    disk_bus='sata' if request['guest_os']=='windows11' else (disk.attrib.get('bus','virtio') if disk is not None else 'virtio'),
                    nic='e1000e' if request['guest_os']=='windows11' else (network.attrib.get('type','virtio') if network is not None else 'virtio'),
                    video=video.attrib.get('type','virtio') if video is not None else 'virtio',
                    firmware_code=code,firmware_vars=variables,libvirt_uri=uri,
                    build_network='qemu user-mode NAT (host 10.0.2.2)',
                    deploy_network='network=default' if uri.endswith('/system') else 'user')
    request['osinfo']=selected
    (folder/'osinfo-profile.json').write_text(json.dumps(selected,indent=2)+'\n')
    return selected
