#!/usr/bin/env python3
"""Keep Debian's original boot image/package tree and add the VAMP setup payload."""
import argparse
from pathlib import Path
import subprocess
import tempfile
import pycdlib


def build(source_iso, setup_iso, output):
    source_iso=Path(source_iso).resolve(strict=True);setup_iso=Path(setup_iso).resolve(strict=True);output=Path(output).resolve()
    if output in (source_iso,setup_iso) or output.exists():
        raise ValueError('Choose a new output path; source ISOs are never overwritten')
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='vamp-debian-payload-') as temporary:
        stage=Path(temporary);iso=pycdlib.PyCdlib();iso.open(str(setup_iso))
        try:
            for directory, dirs, files in iso.walk(rr_path='/'):
                target=stage/directory.lstrip('/');target.mkdir(parents=True,exist_ok=True)
                for name in files:
                    destination=target/name
                    iso.get_file_from_iso(local_path=str(destination),rr_path=directory.rstrip('/')+'/'+name)
                    destination.chmod(0o755 if name.endswith('.sh') else 0o644)
        finally:iso.close()
        command=['xorriso','-indev',str(source_iso),'-outdev',str(output),'-boot_image','any','replay','-map',str(stage),'/vamp']
        result=subprocess.run(command,capture_output=True,text=True,timeout=300)
        output.with_suffix('.log').write_text(result.stdout+'\n'+result.stderr)
        if result.returncode:
            raise RuntimeError(result.stderr[-1000:])
    return str(output)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--setup',required=True);parser.add_argument('--output',required=True);args=parser.parse_args();print(build(args.source,args.setup,args.output))
