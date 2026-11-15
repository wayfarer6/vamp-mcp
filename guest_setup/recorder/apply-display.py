#!/usr/bin/env python3
"""Run inside the guest desktop session at every login; compact machine-readable result."""
import argparse
from datetime import datetime,timezone
import importlib.util
import json
import os
from pathlib import Path
import sys
import time


def execute(attempts=8,delay=5,backend=None):
    backend=backend or ('windows' if sys.platform=='win32' else 'gnome')
    file=Path(__file__).with_name(backend+'-display.py')
    spec=importlib.util.spec_from_file_location('vamp_guest_display',file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    last=None
    for attempt in range(1,attempts+1):
        try:
            last=module.apply()
            if last.get('resolution_verified'):break
        except Exception as exc:
            last={'status':'needs_attention','resolution_verified':False,'error':str(exc)}
        if attempt<attempts:time.sleep(delay)
    return {**last,'backend':backend,'target_resolution':[1920,1080],'attempts':attempt,
            'timestamp':datetime.now(timezone.utc).isoformat(),'scope':'logged_in_guest_user',
            'always_runs_at_login':True}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',default=str(Path(__file__).with_name('result.json')))
    parser.add_argument('--attempts',type=int,default=8)
    parser.add_argument('--delay',type=float,default=5)
    args=parser.parse_args()
    if not 1<=args.attempts<=12 or not 0<=args.delay<=10:parser.error('Invalid retry limits')
    result=execute(args.attempts,args.delay)
    output=Path(args.output).expanduser();output.parent.mkdir(parents=True,exist_ok=True)
    temporary=output.with_suffix('.tmp');temporary.write_text(json.dumps(result,indent=2)+'\n');temporary.replace(output)
    if sys.stdout:print(json.dumps(result))
    sys.exit(0 if result['resolution_verified'] else 1)
