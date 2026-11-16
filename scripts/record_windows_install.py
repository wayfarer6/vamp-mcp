#!/usr/bin/env python3
"""Record bounded Robot segments until the deterministic Windows setup marker."""
import json
from pathlib import Path
import subprocess
import sys
import time
ROOT=Path(__file__).resolve().parents[1]
base=ROOT/'artifacts/kvm-validation'
started=time.monotonic()
for segment in range(3,13):
    output=base/f'windows-install-segment-{segment:02}'
    if output.exists():continue
    with (base/f'windows-install-segment-{segment:02}.log').open('w') as log:
        run=subprocess.run([sys.executable,'-m','robot','--listener','spice_recording.RecordingListener',
            '--outputdir',str(output),'backends/kvm/rpas/validation/windows_install.robot'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
    result=json.loads((output/'summary.json').read_text()) if (output/'summary.json').exists() else {'status':'error'}
    (base/'windows-install-monitor.json').write_text(json.dumps({**result,'last_segment':str(output)},indent=2))
    if result['status']=='installed_and_prepared' or run.returncode or time.monotonic()-started>2400:break
