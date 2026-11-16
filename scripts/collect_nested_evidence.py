"""Collect bounded JSON evidence emitted by the disposable lab's serial port."""
import argparse
import base64
import json
import hashlib
from pathlib import Path
import re

def collect(serial,output):
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    history=[];latest={}
    previous=output/'history.json'
    if previous.exists():
        history=json.loads(previous.read_text())
    seen={json.dumps(row,sort_keys=True,ensure_ascii=False) for row in history}
    serial=Path(serial)
    # libvirt rotates the serial stream mid-line; concatenate without a separator.
    rotated=sorted(serial.parent.glob(serial.name+'.[0-9]*'),key=lambda p:int(p.suffix[1:]),reverse=True)
    stream=''.join(p.read_text(errors='replace') for p in [*rotated,serial])
    for line in stream.splitlines():
        if line.startswith(('VAMP-PNG64 ','VAMP-IMG64 ')) and len(line)<4*1024*1024:
            try:
                _,name,sha,encoded=line.split(' ',3)
                data=base64.b64decode(encoded,validate=True)
                signature=(name.endswith('.png') and data.startswith(b'\x89PNG\r\n\x1a\n')) or (name.endswith('.jpg') and data.startswith(b'\xff\xd8'))
                if re.fullmatch(r'[a-zA-Z0-9_-]{1,70}\.(png|jpg)',name) and hashlib.sha256(data).hexdigest()==sha and signature:
                    (output/name).write_bytes(data)
            except ValueError:pass
        if 'VAMP-EVIDENCE ' not in line:continue
        encoded=line.split('VAMP-EVIDENCE ',1)[1]
        if len(encoded)>128*1024:continue
        try:
            record=json.loads(base64.b64decode(encoded,validate=True))
            stage=record['stage'].casefold()
            if not re.fullmatch(r'[a-z0-9_-]{1,80}',stage):continue
            key=json.dumps(record,sort_keys=True,ensure_ascii=False)
            if key not in seen:history.append(record);seen.add(key)
            (output/(stage+'.json')).write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
        except (ValueError,KeyError,TypeError):continue
    history.sort(key=lambda r:r.get('timestamp',''))
    for record in history:
        phase,_,status=record['stage'].casefold().rpartition('-')
        if status in ('started','passed','failed','requested'):latest[phase]=record
    (output/'history.json').write_text(json.dumps(history,ensure_ascii=False,indent=2)+'\n')
    (output/'latest.json').write_text(json.dumps(latest,ensure_ascii=False,indent=2)+'\n')
    return {phase:{'stage':r['stage'],'timestamp':r['timestamp']} for phase,r in latest.items()}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--serial',default='artifacts/vms/vamp-nested-hyperv-lab/serial.log');p.add_argument('--output',default='artifacts/kvm-validation/nested-evidence');a=p.parse_args();print(json.dumps(collect(a.serial,a.output),indent=2))
