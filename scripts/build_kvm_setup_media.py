#!/usr/bin/env python3
"""Package guest setup scripts and already verified portable CLI files into an ISO."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import stat
import tempfile
import tarfile
import zipfile
import pycdlib

ROOT=Path(__file__).resolve().parents[1]


def build(output, bin_dir):
    output=Path(output).resolve();output.parent.mkdir(parents=True,exist_ok=True)
    bin_dir=Path(bin_dir).resolve(strict=True)
    binary=bin_dir/'veracrypt-appimage/squashfs-root/usr/bin/veracrypt'
    if not binary.is_file():
        raise ValueError('Run the verified Vault CLI downloader before building the guest setup ISO')
    with tempfile.TemporaryDirectory(prefix='vamp-setup-') as temporary:
        stage=Path(temporary)
        shutil.copytree(ROOT/'guest_setup/recorder',stage/'recorder',ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copytree(ROOT/'guest_setup/vault',stage/'vault')
        shutil.copy2(ROOT/'guest_setup/kvm/setup-debian.sh',stage/'setup-debian.sh')
        shutil.copy2(ROOT/'backends/kvm/rpas/validation/index.html',stage/'index.html')
        with zipfile.ZipFile(stage/'recorder/recorder.zip','w',zipfile.ZIP_DEFLATED) as archive:
            for path in sorted((ROOT/'third_party/pyautogui-recorder').rglob('*')):
                if path.is_file():archive.write(path,str(path.relative_to(ROOT/'third_party/pyautogui-recorder')))
        cli=stage/'cli';cli.mkdir()
        with tarfile.open(cli/'veracrypt.tar.gz', 'w:gz', dereference=True) as archive:
            archive.add(bin_dir/'veracrypt-appimage', arcname='veracrypt-appimage')
        digest=hashlib.file_digest((cli/'veracrypt.tar.gz').open('rb'),'sha256').hexdigest()
        (cli/'SHA256SUMS').write_text(digest+'  veracrypt.tar.gz\n')
        iso=pycdlib.PyCdlib();iso.new(interchange_level=3,joliet=3,rock_ridge='1.09',vol_ident='VAMP_SETUP')
        paths={stage:('', '')};counter=0
        try:
            for folder in sorted([p for p in stage.rglob('*') if p.is_dir()],key=lambda p:(len(p.parts),str(p))):
                counter+=1;parent_iso,parent_joliet=paths[folder.parent]
                iso_path=parent_iso+f'/D{counter:06}';joliet_path=parent_joliet+'/'+folder.name
                iso.add_directory(iso_path=iso_path,rr_name=folder.name,joliet_path=joliet_path,file_mode=0o40555)
                paths[folder]=(iso_path,joliet_path)
            for path in sorted(stage.rglob('*')):
                if not path.is_file():continue
                counter+=1;parent_iso,parent_joliet=paths[path.parent]
                iso.add_file(str(path),iso_path=parent_iso+f'/F{counter:06}.BIN;1',rr_name=path.name,
                             joliet_path=parent_joliet+'/'+path.name,file_mode=stat.S_IFREG|stat.S_IMODE(path.stat().st_mode))
            iso.write(str(output))
        finally:iso.close()
    return {'status':'media_built','iso':str(output),'sha256':hashlib.file_digest(output.open('rb'),'sha256').hexdigest(),'guest_setup_completed':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--bin-dir',required=True);args=parser.parse_args()
    print(json.dumps(build(args.output,args.bin_dir),indent=2))
