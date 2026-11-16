#!/usr/bin/env python3
"""Add a disposable lab preseed and BIOS autoboot menu; preserve the source DVD."""
import argparse
from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[1]

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    source=Path(a.source).resolve(strict=True);output=Path(a.output).resolve()
    if output.exists() or source==output:raise ValueError('Choose a new output ISO path')
    output.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run(['xorriso','-indev',str(source),'-outdev',str(output),'-boot_image','any','replay',
        '-map',str(ROOT/'scripts/windows/debian-remote-preseed.cfg'),'/preseed.cfg',
        '-map',str(ROOT/'scripts/windows/debian-remote-isolinux.cfg'),'/isolinux/isolinux.cfg'],check=True)
