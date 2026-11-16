#!/usr/bin/env python3
"""Unattended Windows seed, validated installers and guest scripts; no activation."""
import argparse
import io
import json
from pathlib import Path
import struct
import xml.etree.ElementTree as ET
import zipfile
import pycdlib

ROOT=Path(__file__).resolve().parents[1]
NS='urn:schemas-microsoft-com:unattend'
WCM='http://schemas.microsoft.com/WMIConfig/2002/State'
ET.register_namespace('',NS);ET.register_namespace('wcm',WCM)


def windows_images(source):
    iso=pycdlib.PyCdlib();iso.open(str(source))
    try:
        with iso.open_file_from_iso(udf_path='/sources/install.wim') as stream:
            header=stream.read(208)
            if header[:8]!=b'MSWIM\x00\x00\x00':raise ValueError('Unsupported Windows install image')
            size=struct.unpack_from('<Q',header,72)[0]&((1<<56)-1)
            offset=struct.unpack_from('<Q',header,80)[0]
            if size>8*1024*1024:raise ValueError('Windows image metadata is unexpectedly large')
            stream.seek(offset);xml=ET.fromstring(stream.read(size).decode('utf-16'))
        return [{'index':int(image.get('INDEX')),'edition':image.findtext('WINDOWS/EDITIONID'),'locale':image.findtext('WINDOWS/LANGUAGES/DEFAULT'),'name':image.findtext('NAME')} for image in xml.findall('IMAGE')]
    finally:iso.close()


def answer_file(image, name):
    root=ET.Element('{'+NS+'}unattend')
    def add(parent,tag,text=None,**attributes):
        node=ET.SubElement(parent,'{'+NS+'}'+tag,attributes)
        if text is not None:node.text=str(text)
        return node
    def component(settings,name):
        return add(settings,'component',name=name,processorArchitecture='amd64',publicKeyToken='31bf3856ad364e35',language='neutral',versionScope='nonSxS')
    pe=add(root,'settings',pass_='windowsPE');pe.attrib['pass']=pe.attrib.pop('pass_')
    intl=component(pe,'Microsoft-Windows-International-Core-WinPE')
    add(add(intl,'SetupUILanguage'),'UILanguage',image['locale'])
    for tag,val in [('InputLocale','0409:00000409'),('SystemLocale',image['locale']),('UILanguage',image['locale']),('UserLocale',image['locale'])]:add(intl,tag,val)
    setup=component(pe,'Microsoft-Windows-Setup')
    diskconfig=add(setup,'DiskConfiguration');disk=add(diskconfig,'Disk',**{'{'+WCM+'}action':'add'})
    add(disk,'DiskID',0);add(disk,'WillWipeDisk','true')
    creates=add(disk,'CreatePartitions')
    for order,kind,size in [(1,'EFI',260),(2,'MSR',16),(3,'Primary',None)]:
        part=add(creates,'CreatePartition',**{'{'+WCM+'}action':'add'});add(part,'Order',order);add(part,'Type',kind);add(part,'Extend','true') if size is None else add(part,'Size',size)
    modifies=add(disk,'ModifyPartitions')
    for order,partid,fmt,label,letter in [(1,1,'FAT32','System',None),(2,3,'NTFS','Windows','C')]:
        part=add(modifies,'ModifyPartition',**{'{'+WCM+'}action':'add'})
        for tag,val in [('Order',order),('PartitionID',partid),('Format',fmt),('Label',label)]:add(part,tag,val)
        if letter:add(part,'Letter',letter)
    add(diskconfig,'WillShowUI','OnError')
    osinstall=add(add(setup,'ImageInstall'),'OSImage')
    metadata=add(add(osinstall,'InstallFrom'),'MetaData',**{'{'+WCM+'}action':'add'});add(metadata,'Key','/IMAGE/INDEX');add(metadata,'Value',image['index'])
    target=add(osinstall,'InstallTo');add(target,'DiskID',0);add(target,'PartitionID',3);add(osinstall,'WillShowUI','OnError')
    userdata=add(setup,'UserData');add(userdata,'AcceptEula','true');add(userdata,'FullName','VAMP Test')
    # Microsoft's public Pro installation key selects the edition; it does not activate Windows.
    if image['edition']=='Professional':
        key=add(userdata,'ProductKey');add(key,'Key','VK7JG-NPHTM-C97JM-9MPGT-3V66T');add(key,'WillShowUI','Never')
    specialize=add(root,'settings',**{'pass':'specialize'})
    shell=component(specialize,'Microsoft-Windows-Shell-Setup');add(shell,'ComputerName',name[:15]);add(shell,'TimeZone','Korea Standard Time')
    oobe=add(root,'settings',**{'pass':'oobeSystem'})
    intl=component(oobe,'Microsoft-Windows-International-Core')
    for tag,val in [('InputLocale','0409:00000409'),('SystemLocale',image['locale']),('UILanguage',image['locale']),('UserLocale',image['locale'])]:add(intl,tag,val)
    shell=component(oobe,'Microsoft-Windows-Shell-Setup');o=add(shell,'OOBE')
    for tag,val in [('HideEULAPage','true'),('HideOnlineAccountScreens','true'),('HideWirelessSetupInOOBE','true'),('ProtectYourPC','3')]:add(o,tag,val)
    accounts=add(add(shell,'UserAccounts'),'LocalAccounts');account=add(accounts,'LocalAccount',**{'{'+WCM+'}action':'add'})
    for tag,val in [('Name','vboxuser'),('DisplayName','VAMP Test'),('Group','Administrators')]:add(account,tag,val)
    password=add(account,'Password');add(password,'Value','password123!');add(password,'PlainText','true')
    auto=add(shell,'AutoLogon');add(auto,'Username','vboxuser');add(auto,'Enabled','true');add(auto,'LogonCount',5)
    password=add(auto,'Password');add(password,'Value','password123!');add(password,'PlainText','true')
    commands=add(shell,'FirstLogonCommands');command=add(commands,'SynchronousCommand',**{'{'+WCM+'}action':'add'})
    add(command,'Order',1);add(command,'Description','Install and verify VAMP guest tools')
    line='powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$d=Get-CimInstance Win32_LogicalDisk | Where-Object {Test-Path ($_.DeviceID+\'\\setup-windows.ps1\')} | Select-Object -First 1; if(-not $d){throw \'VAMP setup media missing\'}; $t=\'C:\\ProgramData\\VAMP-Setup\'; New-Item -ItemType Directory -Force $t | Out-Null; Copy-Item ($d.DeviceID+\'\\*\') $t -Recurse -Force; & ($t+\'\\setup-windows.ps1\')"'
    add(command,'CommandLine',line);add(command,'RequiresUserInput','false')
    return ET.tostring(root,encoding='utf-8',xml_declaration=True)


def build(source, installers, output, name='VAMP-Windows'):
    images=windows_images(source);image=next((i for i in images if i['edition']=='Professional'),None)
    if image is None:raise ValueError('This automated profile requires a Windows Pro image')
    installers=Path(installers);manifest=json.loads((installers/'manifest.json').read_text())
    files={'Autounattend.xml':answer_file(image,name),'setup-windows.ps1':(ROOT/'guest_setup/kvm/setup-windows.ps1').read_bytes()}
    files['Initialize-NestedLab.ps1']=(ROOT/'backends/hyperv/scripts/Initialize-NestedLab.ps1').read_bytes()
    for folder in ['recorder','vault']:
        files.update({folder+'/'+p.name:p.read_bytes() for p in (ROOT/'guest_setup'/folder).iterdir() if p.is_file()})
    payload=io.BytesIO()
    with zipfile.ZipFile(payload,'w',zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((ROOT/'third_party/pyautogui-recorder').rglob('*')):
            if path.is_file():archive.write(path,str(path.relative_to(ROOT/'third_party/pyautogui-recorder')))
    files['recorder/recorder.zip']=payload.getvalue()
    files['installers/manifest.json']=(installers/'manifest.json').read_bytes()
    for info in manifest.values():files['installers/'+Path(info['path']).name]=Path(info['path']).read_bytes()
    iso=pycdlib.PyCdlib();iso.new(interchange_level=3,joliet=3,vol_ident='VAMP_WIN_SETUP');buffers=[]
    try:
        for folder in ['recorder','vault','installers']:iso.add_directory(iso_path='/'+folder.upper(),joliet_path='/'+folder)
        for index,(name,data) in enumerate(files.items()):
            parent=name.rpartition('/')[0];path=('/'+parent.upper() if parent else '')+f'/F{index:04}.DAT;1'
            stream=io.BytesIO(data);buffers.append(stream);iso.add_fp(stream,len(data),iso_path=path,joliet_path='/'+name)
        iso.write(str(Path(output).resolve()))
    finally:iso.close()
    return {'status':'media_built','image':image,'iso':str(Path(output).resolve()),'windows_activation_performed':False}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--installers',required=True);p.add_argument('--output',required=True);a=p.parse_args();print(json.dumps(build(a.source,a.installers,a.output),indent=2))
