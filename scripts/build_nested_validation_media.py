#!/usr/bin/env python3
"""Prepare source-only Windows nested validation media, without guest secrets."""
import argparse
import io
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile
import pycdlib
from scripts.build_windows_setup_media import NS, answer_file
ROOT=Path(__file__).resolve().parents[1]

def build(output,host_installers=None,include_extensions=False):
    answer=ET.fromstring(answer_file({'locale':'ko-KR','edition':'Professional','index':3},'VAMP-Nested'))
    for settings in list(answer):
        if settings.get('pass')=='windowsPE':answer.remove(settings);continue
        for shell in settings:
            for child in list(shell):
                if child.tag=='{'+NS+'}FirstLogonCommands':shell.remove(child)
    bundle=io.BytesIO()
    with zipfile.ZipFile(bundle,'w',zipfile.ZIP_DEFLATED) as archive:
        paths=[ROOT/'vm_mcp_server.py',ROOT/'rpa_package.py',ROOT/'rpa_contract.py',ROOT/'requirements-mcp.txt',ROOT/'scripts/kvm_mcp_call.py',ROOT/'scripts/validate_windows_mcp.py',ROOT/'scripts/validate_windows_vault.py',ROOT/'scripts/validate_windows_virtualbox.py',ROOT/'config/vm-mcp.json']
        for folder in ['mcp_vm','backends/hyperv','backends/virtualbox','guest_setup/vault',
                       'third_party/mcp-virtualbox/dist','third_party/mcp-virtualbox/scripts',
                       'vscode-vault-extension/src','vscode-vault-extension/backends/vault',
                       'vscode-vault-extension/test','scripts/vscode-probe']:
            paths.extend(p for p in (ROOT/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
        paths.extend(ROOT/'third_party/mcp-virtualbox'/name for name in ['package.json','package-lock.json','LICENSE','PROVENANCE.json'])
        paths.extend(ROOT/'vscode-vault-extension'/name for name in ['package.json','package-lock.json','extension.js'])
        for path in paths:archive.write(path,path.relative_to(ROOT))
    files={'nested-unattend.xml':ET.tostring(answer,encoding='utf-8',xml_declaration=True),'vamp-source.zip':bundle.getvalue(),
           'Run.ps1':(ROOT/'backends/hyperv/scripts/Invoke-NestedValidation.ps1').read_bytes()}
    if host_installers:
        directory=Path(host_installers);files['host-installers.json']=(directory/'manifest.json').read_bytes()
        for row in json.loads(files['host-installers.json']).values():
            p=Path(row['path']);files[p.name]=p.read_bytes()
    if include_extensions:
        package=json.loads((ROOT/'vscode-extension/package.json').read_text())
        files['vamp-mcp.vsix']=(ROOT/'artifacts'/('vamp-mcp-'+package['version']+'.vsix')).read_bytes()
        package=json.loads((ROOT/'vscode-vault-extension/package.json').read_text())
        files['vamp-vault.vsix']=(ROOT/'vscode-vault-extension'/('vamp-vault-'+package['version']+'.vsix')).read_bytes()
        fixture=ROOT/'artifacts/kvm-validation/veracrypt-fixture.hc'
        if fixture.is_file():files['veracrypt-fixture.hc']=fixture.read_bytes()
    iso=pycdlib.PyCdlib();iso.new(interchange_level=3,joliet=3,vol_ident='VAMP_NESTED_TEST');streams=[]
    try:
        for index,(name,data) in enumerate(files.items()):
            stream=io.BytesIO(data);streams.append(stream)
            iso.add_fp(stream,len(data),iso_path=f'/F{index:04}.DAT;1',joliet_path='/'+name)
        iso.write(str(Path(output).resolve()))
    finally:iso.close()
    return {'status':'built','iso':str(Path(output).resolve()),'files':list(files)}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--host-installers');p.add_argument('--include-extensions',action='store_true');a=p.parse_args();print(json.dumps(build(a.output,a.host_installers,a.include_extensions),indent=2))
