#!/usr/bin/env python3
"""Idempotent GDM Xorg/autologin configuration for the public VAMP sandbox."""
from pathlib import Path
import re

def configure(path):
    path=Path(path);text=path.read_text() if path.exists() else ''
    lines=text.splitlines();result=[];section=None;inserted=False
    values=['WaylandEnable=false','AutomaticLoginEnable=true','AutomaticLogin=vboxuser']
    for line in lines:
        match=re.match(r'\s*\[([^]]+)\]',line)
        if match:
            section=match[1]
            result.append(line)
            if section=='daemon':result.extend(values);inserted=True
            continue
        if section=='daemon' and re.match(r'\s*#?\s*(WaylandEnable|AutomaticLoginEnable|AutomaticLogin)\s*=',line):continue
        result.append(line)
    if not inserted:result=['[daemon]',*values,'',*result]
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text('\n'.join(result)+'\n')

if __name__=='__main__':
    configure('/etc/gdm3/daemon.conf')
