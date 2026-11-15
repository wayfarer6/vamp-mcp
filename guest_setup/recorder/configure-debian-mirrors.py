#!/usr/bin/env python3
"""Disable installation-CD APT entries and configure official Debian network mirrors."""
from datetime import datetime,timezone
import json
import os
from pathlib import Path
import re
import shutil


def configure(root=Path('/')):
    root=Path(root)
    release=dict(re.findall(r'^([A-Z_]+)=["\']?([^"\'\n]+)',(root/'etc/os-release').read_text(),re.M))
    if release.get('ID')!='debian':return {'status':'not_debian','changed':False}
    suite=release.get('VERSION_CODENAME','')
    if not re.fullmatch(r'[a-z][a-z0-9-]*',suite):raise ValueError('Cannot determine installed Debian codename')
    apt=root/'etc/apt';source_dir=apt/'sources.list.d';source_dir.mkdir(parents=True,exist_ok=True)
    backup=root/'var/backups'/('vamp-apt-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f'))
    changed=[]
    for path in [apt/'sources.list',*sorted(source_dir.glob('*.list')),*sorted(source_dir.glob('*.sources'))]:
        if not path.is_file() or path.name=='vamp-debian.sources':continue
        old=path.read_text()
        if path.suffix=='.sources':
            stanzas=re.split(r'\n\s*\n',old)
            kept=[]
            for stanza in stanzas:
                uri=re.search(r'^URIs:\s*(.*)',stanza,re.M|re.I)
                if uri and uri[1].lower().startswith('cdrom:'):continue
                kept.append(stanza)
            new='\n\n'.join(kept)
        else:
            new=''.join(line for line in old.splitlines(keepends=True)
                if not re.match(r'^\s*deb(?:-src)?\s+.*cdrom:',line,re.I))
        if new!=old:
            backup.mkdir(parents=True,exist_ok=True);shutil.copy2(path,backup/(path.parent.name+'-'+path.name))
            path.write_text(new);changed.append(str(path))
    # Reuse a manually configured complete official network list without duplicating it.
    enabled='\n'.join(p.read_text() for p in [apt/'sources.list',*source_dir.glob('*.list')] if p.is_file())
    active='\n'.join(line for line in enabled.splitlines() if line.strip().startswith('deb '))
    complete=all(re.search(r'\b'+re.escape(part)+r'\b',active) for part in [suite,suite+'-updates',suite+'-security']) and 'deb.debian.org' in active and 'security.debian.org' in active
    target=source_dir/'vamp-debian.sources'
    if not complete:
        desired=f'''Types: deb
URIs: https://deb.debian.org/debian
Suites: {suite} {suite}-updates
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: https://security.debian.org/debian-security
Suites: {suite}-security
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
'''
        if not target.exists() or target.read_text()!=desired:target.write_text(desired);changed.append(str(target))
    return {'status':'configured','suite':suite,'cdrom_sources_disabled':True,'changed':changed,
            'mirrors':['https://deb.debian.org/debian','https://security.debian.org/debian-security'],
            'note':'Run apt-get update; does not upgrade to another Debian release.'}

if __name__=='__main__':
    if os.geteuid()!=0:raise SystemExit('Run inside the Debian guest as root')
    print(json.dumps(configure()))
