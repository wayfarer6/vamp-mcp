"""Run the real VAMP stdio tools on a Windows host; no VM creation or shutdown."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import platform
import sys
import traceback

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backends/virtualbox'))
from client import request


async def smoke(vm=None, output='artifacts/windows-host'):
    folder = Path(output).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    report = {'host': platform.platform(), 'python': sys.version.split()[0], 'checks': [],
              'status': 'running', 'vm_created': False}
    try:
        for name, args in [('vm_list', {}), ('vamp_setup', {}), ('vm_run_history', {'limit': 1})]:
            result = await request(name, args)
            report['checks'].append({'tool': name, 'result': result})
        if vm:
            for name in ('vm_info', 'vm_screen_info', 'vm_screenshot'):
                result = await request(name, {'vm': vm}, str(folder / 'guest.png') if name == 'vm_screenshot' else None)
                report['checks'].append({'tool': name, 'result': result})
        report['status'] = 'passed'
    except Exception as error:
        report.update(status='failed', error=str(error), traceback=''.join(traceback.format_exception(error)))
    (folder / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return report['status'] == 'passed'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vm', help='An existing running nested VM; omit for host inventory checks only')
    parser.add_argument('--output', default='artifacts/windows-host')
    args = parser.parse_args()
    raise SystemExit(0 if asyncio.run(smoke(args.vm, args.output)) else 1)
