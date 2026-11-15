#!/usr/bin/env python3
"""Guest-side handoff: describe a saved Python recording without executing it."""
import argparse
import ast
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import sys


def describe(path):
    path=Path(path).expanduser().resolve(strict=True)
    if not path.is_file() or path.stat().st_size>5_000_000:raise ValueError('Expected a Python recording file under 5 MB')
    code=path.read_text(encoding='utf-8-sig');tree=ast.parse(code,filename=str(path))
    # Identify calls only; never evaluate, import or play the recording.
    calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call)]
    return {'schema_version':1,'status':'ready_for_ai_review','recording_path_in_guest':str(path),
            'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size,
            'call_count':len(calls),'source_executed':False,'guest_platform':sys.platform,
            'expected_native_resolution':[1920,1080],
            'resolution_must_be_checked':True,'timestamp':datetime.now(timezone.utc).isoformat(),
            'handoff':'Tell the AI the VM name, guest OS and this file path. A guest path is not automatically a host path; transfer the file or authorize an explicit retrieval method. Do not record credentials.'}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('recording')
    args=parser.parse_args();result=describe(args.recording)
    output=Path(args.recording).resolve().with_suffix('.handoff.json')
    output.write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
    print(json.dumps({**result,'handoff_file':str(output)},ensure_ascii=False))
