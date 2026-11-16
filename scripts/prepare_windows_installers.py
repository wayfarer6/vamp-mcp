#!/usr/bin/env python3
"""Download x64 guest installers from Microsoft winget manifests, verify SHA-256."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import requests
import yaml

PACKAGES={'python':('p/Python/Python/3/12','Python.Python.3.12'),
          'keepassxc':('k/KeePassXCTeam/KeePassXC','KeePassXCTeam.KeePassXC'),
          'veracrypt':('i/IDRIX/VeraCrypt','IDRIX.VeraCrypt'),
          'virtio':('r/RedHat/VirtIO','RedHat.VirtIO'),
          'vcredist':('m/Microsoft/VCRedist/2015+/x64','Microsoft.VCRedist.2015+.x64')}
BASE='https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/'


def prepare(output, packages=None):
    output=Path(output).resolve();output.mkdir(parents=True,exist_ok=True)
    session=requests.Session();session.headers['User-Agent']='VAMP-local-validation'
    result={}
    for label,(folder,identifier) in (PACKAGES if packages is None else packages).items():
        response=session.get('https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/'+folder,timeout=30);response.raise_for_status()
        versions=[item['name'] for item in response.json() if item['type']=='dir' and re.fullmatch(r'\d+(?:\.\d+)+(?:-\d+)?',item['name'])]
        version=max(versions,key=lambda v:tuple(int(part) for part in re.split('[.-]',v)))
        manifest_url=BASE+folder+'/'+version+'/'+identifier+'.installer.yaml'
        response=session.get(manifest_url,timeout=30);response.raise_for_status();manifest=yaml.safe_load(response.text)
        installers=[{**manifest,**item} for item in manifest['Installers'] if item.get('Architecture')=='x64']
        installers.sort(key=lambda item:(item.get('Scope')!='machine',item.get('InstallerType') not in ('wix','msi','nullsoft','inno')))
        if not installers and label=='virtio':
            installers=[{**manifest,**item} for item in manifest['Installers']]
        installer=installers[0];url=installer['InstallerUrl'];expected=installer['InstallerSha256'].lower()
        path=output/(label+Path(url.split('?')[0]).suffix)
        if not path.exists() or hashlib.file_digest(path.open('rb'),'sha256').hexdigest()!=expected:
            temporary=path.with_suffix(path.suffix+'.part')
            with session.get(url,stream=True,timeout=(30,180)) as response:
                response.raise_for_status()
                with temporary.open('wb') as stream:
                    for block in response.iter_content(1024*1024):stream.write(block)
            if hashlib.file_digest(temporary.open('rb'),'sha256').hexdigest()!=expected:
                temporary.unlink();raise ValueError(label+' installer checksum mismatch')
            temporary.replace(path)
        result[label]={'path':str(path),'version':version,'sha256':expected,'installer_url':url,'manifest_url':manifest_url,'installer_type':installer.get('InstallerType'),'switches':installer.get('InstallerSwitches',{})}
        print(label,version,'SHA-256 verified',flush=True)
    (output/'manifest.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args();prepare(args.output)
