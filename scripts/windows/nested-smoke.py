"""Opt-in diskless EFI lab VM: exercise real Windows-host MCP transport/input.

Reuses an existing diskless lab VM, or explicitly creates a uniquely named one.
Leaves it running for inspection; does not reconfigure or stop an existing VM.
"""
import argparse
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backends/virtualbox'))
from client import request
from provision import executable


async def smoke(folder, existing_vm=None):
    folder = Path(folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    name = existing_vm or ('VAMP-Nested-Smoke-' + time.strftime('%Y%m%d-%H%M%S'))
    report = {'vm': name, 'status': 'running', 'guest': 'diskless EFI firmware; no installed OS', 'checks': [],
              'vm_created': False, 'started_at': time.time()}
    def save_report():
        (folder / 'nested-result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    save_report()
    def vbox(*args):
        result = subprocess.run([executable(), *args], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return result.stdout
    try:
        if not existing_vm:
            # createvm refuses an existing VM; no existing settings are modified.
            vbox('createvm', '--name', name, '--ostype', 'Linux_64', '--register')
            report['vm_created'] = True
            vbox('modifyvm', name, '--memory', '256', '--cpus', '1', '--vram', '16',
                 '--firmware', 'efi', '--graphicscontroller', 'vboxvga', '--nic1', 'none',
                 '--mouse', 'usbtablet', '--usb-xhci', 'on', '--boot1', 'none',
                 '--boot2', 'none', '--boot3', 'none', '--boot4', 'none')
        for tool, args in [('vm_list', {}), ('vm_info', {'vm': name}),
                           ('vm_start', {'vm': name, 'type': 'separate'})]:
            report['checks'].append({'tool': tool, 'result': await request(tool, args)})
            save_report()
        await asyncio.sleep(2)
        # Precondition: EFI main menu, Boot Manager selected (see lab guide).
        report['checks'].append({'tool': 'vm_keyboard_scancode', 'result': await request(
            'vm_keyboard_scancode', {'vm': name, 'keys': 'enter'})})
        await asyncio.sleep(2)
        report['checks'].append({'tool': 'vm_screenshot_before', 'result': await request(
            'vm_screenshot', {'vm': name}, str(folder / 'nested-before.png'))})
        for tool, args in [
            ('vm_screen_info', {'vm': name}),
            ('vm_keyboard_scancode', {'vm': name, 'keys': 'esc'}),
        ]:
            report['checks'].append({'tool': tool, 'result': await request(tool, args)})
            save_report()
        await asyncio.sleep(2)
        result = await request('vm_screenshot', {'vm': name}, str(folder / 'nested.png'))
        report['checks'].append({'tool': 'vm_screenshot', 'result': result})
        report['status'] = 'transport_passed_visual_assertion_pending'
    except Exception as error:
        report.update(status='failed', error=str(error))
    save_report()
    print(json.dumps(report, indent=2))
    return report['status'] != 'failed'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vm', help='Reuse an existing diskless lab VM; never recreates or reconfigures it')
    parser.add_argument('--create', action='store_true', help='Explicitly opt into creating a new diskless lab VM')
    parser.add_argument('--output', default='artifacts/windows-host')
    args = parser.parse_args()
    if bool(args.create) == bool(args.vm):
        parser.error('Choose exactly one of --create or --vm NAME')
    raise SystemExit(0 if asyncio.run(smoke(args.output, args.vm)) else 1)
